import { readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { CustomEditor, SessionManager, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

type SessionInfoLite = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  modified: Date;
};

const MAX_REFERENCES_PER_PROMPT = 3;
const MAX_BLOCK_CHARS = 3500;
const MAX_LINE_CHARS = 280;
const MAX_LINES = 12;
const BADGE_DURATION_MS = 3000;
const PANEL_MARGIN_RATIO = 0;
const PANEL_MARGIN_MIN = 0;
const PANEL_MARGIN_MAX = 0;
const PICKER_MAX_ITEMS = 8;
const PICKER_MAX_FILES = 4000;
const FILE_SCAN_EXCLUDES = new Set([".git", "node_modules", ".pi", ".agents", "dist", "build"]);
const FALLBACK_BUILT_IN_COMMANDS = [
  "login",
  "logout",
  "model",
  "scoped-models",
  "settings",
  "resume",
  "new",
  "name",
  "session",
  "tree",
  "fork",
  "compact",
  "copy",
  "export",
  "share",
  "reload",
  "hotkeys",
  "changelog",
  "quit",
  "exit",
];

let transientBadgeText: string | undefined;
let transientBadgeUntil = 0;
let requestEditorRender: (() => void) | undefined;

function showTransientBadge(text: string): void {
  transientBadgeText = text;
  transientBadgeUntil = Date.now() + BADGE_DURATION_MS;
  requestEditorRender?.();

  setTimeout(() => {
    if (Date.now() >= transientBadgeUntil) {
      requestEditorRender?.();
    }
  }, BADGE_DURATION_MS + 20);
}

function getTransientBadge(): string | undefined {
  if (!transientBadgeText) return undefined;
  if (Date.now() >= transientBadgeUntil) return undefined;
  return transientBadgeText;
}

function panelMargin(width: number): number {
  const byRatio = Math.floor(width * PANEL_MARGIN_RATIO);
  return Math.max(PANEL_MARGIN_MIN, Math.min(PANEL_MARGIN_MAX, byRatio));
}

function stripAnsi(text: string): string {
  // Remove ANSI/control escape sequences including APC cursor markers from pi-tui.
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "") // OSC (BEL or ST)
    .replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "") // APC (BEL or ST)
    .replace(/\x1bP[\s\S]*?(?:\x07|\x1b\\)/g, "") // DCS (BEL or ST)
    .replace(/[\x90-\x9f][\s\S]*?\x9c/g, "") // C1 control-string forms (ST)
    .replace(/\x1b[@-Z\\-_]/g, "") // 2-char sequences
    .replace(/pi:c(?:ursor)?/gi, "") // defensive cleanup if marker payload leaks
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ""); // remaining control chars
}

function fitToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(text);
  if (plain.length >= width) return plain.slice(0, width);
  return plain + " ".repeat(width - plain.length);
}

function wrapPlainText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const source = stripAnsi(text);
  if (source.length === 0) return [""];

  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    out.push(source.slice(i, i + width));
    i += width;
  }
  return out;
}

function paintCursorBlock(text: string, width: number, cursorCol: number): string {
  const fitted = fitToWidth(text, width);
  const idx = Math.max(0, Math.min(width - 1, cursorCol));
  const ch = fitted[idx] || " ";
  return `${fitted.slice(0, idx)}\x1b[7m${ch}\x1b[27m${fitted.slice(idx + 1)}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isArrowUp(data: string): boolean {
  if (data === "up") return true;
  if (/^\x1b(?:\[[0-9;]*A|OA)$/.test(data)) return true;
  // Kitty/extended keyboard protocols can encode arrows in CSI-u forms.
  if (/^\x1b\[[0-9;:]+u$/.test(data) && data.includes("A")) return true;
  // Very defensive fallback: ANSI sequence ending in A.
  if (data.startsWith("\x1b") && data.endsWith("A")) return true;
  return false;
}

function isArrowDown(data: string): boolean {
  if (data === "down") return true;
  if (/^\x1b(?:\[[0-9;]*B|OB)$/.test(data)) return true;
  if (/^\x1b\[[0-9;:]+u$/.test(data) && data.includes("B")) return true;
  if (data.startsWith("\x1b") && data.endsWith("B")) return true;
  return false;
}

function isEnter(data: string): boolean {
  return (
    data === "\r" ||
    data === "\n" ||
    data === "\r\n" ||
    data === "enter" ||
    data === "return" ||
    data.endsWith("\r")
  );
}

function isEscape(data: string): boolean {
  if (data === "\x1b" || data === "\x1b\x1b" || data === "escape" || data === "esc") return true;
  // Extended keyboard protocols sometimes encode Escape as CSI-u.
  if (/^\x1b\[(?:27|27;[0-9:;]+)u$/.test(data)) return true;
  return false;
}

function isTab(data: string): boolean {
  return data === "\t" || data === "tab";
}

function subsequenceScore(value: string, query: string): number {
  if (!query) return 0;

  let qi = 0;
  let gaps = 0;
  let firstMatch = -1;

  for (let vi = 0; vi < value.length && qi < query.length; vi++) {
    if (value[vi] === query[qi]) {
      if (firstMatch === -1) firstMatch = vi;
      qi++;
    } else if (qi > 0) {
      gaps++;
    }
  }

  if (qi !== query.length) return 0;

  // Base score for a subsequence match, minus penalties for gapiness/late start.
  return Math.max(1, 35 - gaps - Math.max(0, firstMatch));
}

function scoreMatch(value: string, query: string): number {
  if (!query) return 1;
  const v = value.toLowerCase();
  const q = query.toLowerCase();
  if (v === q) return 100;
  if (v.startsWith(q)) return 85;
  if (v.includes(q)) return 60;

  // Fuzzy subsequence fallback (e.g. "thream" -> "threads-manage").
  return subsequenceScore(v, q);
}

async function discoverBuiltInCommands(): Promise<string[]> {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve("@mariozechner/pi-coding-agent/package.json");
    const pkgRoot = path.dirname(pkgJsonPath);
    const readmePath = path.join(pkgRoot, "README.md");
    const readme = await readFile(readmePath, "utf8");

    const extracted = [...readme.matchAll(/`\/([a-z][a-z0-9:-]*)[^`]*`/gi)]
      .map((m) => (m[1] || "").trim().toLowerCase())
      .filter(Boolean);

    const merged = Array.from(new Set([...FALLBACK_BUILT_IN_COMMANDS, ...extracted]));
    return merged;
  } catch {
    return [...FALLBACK_BUILT_IN_COMMANDS];
  }
}

async function scanFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= PICKER_MAX_FILES) return;

    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= PICKER_MAX_FILES) return;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (FILE_SCAN_EXCLUDES.has(entry.name)) continue;
        await walk(full);
        continue;
      }

      if (!entry.isFile()) continue;
      files.push(path.relative(cwd, full));
    }
  }

  await walk(cwd);
  return files;
}

function messageText(msg: AgentMessage): string {
  const content: unknown = (msg as { content?: unknown }).content;

  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "thinking" && typeof b.thinking === "string") return "";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function roleLabel(role: string): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "toolResult") return "Tool";
  if (role === "bashExecution") return "Bash";
  return "Message";
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

async function listSessions(currentSessionPath?: string, includeCurrent = false): Promise<SessionInfoLite[]> {
  const all = await SessionManager.listAll();
  return all
    .filter((s) => includeCurrent || !currentSessionPath || s.path !== currentSessionPath)
    .map((s) => ({
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      firstMessage: s.firstMessage,
      modified: toDate(s.modified),
    }))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function threadTitle(s: SessionInfoLite): string {
  const head = (s.name?.trim() || s.firstMessage?.trim() || "Untitled thread").replace(/\s+/g, " ");
  return clip(head, 80);
}

function matchesQuery(s: SessionInfoLite, query: string): boolean {
  const q = query.toLowerCase();
  return (
    s.id.toLowerCase().includes(q) ||
    s.path.toLowerCase().includes(q) ||
    s.cwd.toLowerCase().includes(q) ||
    (s.name || "").toLowerCase().includes(q) ||
    (s.firstMessage || "").toLowerCase().includes(q)
  );
}

function resolveToken(token: string, sessions: SessionInfoLite[]): { session?: SessionInfoLite; error?: string } {
  const key = token.trim().toLowerCase();
  if (!key) return { error: "empty reference" };

  const byIdPrefix = sessions.filter((s) => s.id.toLowerCase().startsWith(key));
  if (byIdPrefix.length === 1) return { session: byIdPrefix[0] };
  if (byIdPrefix.length > 1) return { error: `ambiguous id prefix '${token}'` };

  const byNameContains = sessions.filter((s) =>
    `${s.name || ""} ${s.firstMessage || ""}`.toLowerCase().includes(key),
  );
  if (byNameContains.length === 1) return { session: byNameContains[0] };
  if (byNameContains.length > 1) return { error: `ambiguous name match '${token}'` };

  return { error: `no thread found for '${token}'` };
}

function buildReferenceBlock(session: SessionInfoLite): string {
  try {
    const sm = SessionManager.open(session.path);
    const context = sm.buildSessionContext();

    const messages = context.messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult")
      .map((m) => {
        const text = messageText(m).replace(/\s+/g, " ").trim();
        return {
          role: roleLabel(m.role),
          text: clip(text, MAX_LINE_CHARS),
        };
      })
      .filter((m) => m.text.length > 0);

    const tail = messages.slice(-MAX_LINES);

    const header = [
      `[Thread Reference]`,
      `id: ${session.id}`,
      `title: ${threadTitle(session)}`,
      `cwd: ${session.cwd || "(unknown)"}`,
      `updated: ${session.modified.toISOString()}`,
      `---`,
    ];

    const body = tail.map((m) => `${m.role}: ${m.text}`);
    const block = [...header, ...body].join("\n");
    return clip(block, MAX_BLOCK_CHARS);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `[Thread Reference]\nid: ${session.id}\nerror: failed to read thread (${msg})`;
  }
}

function optionLabel(s: SessionInfoLite): string {
  const date = s.modified.toISOString().replace("T", " ").slice(0, 16);
  return `${threadTitle(s)}  ·  ${date}  ·  ${s.id.slice(0, 8)}`;
}

async function pickSession(
  sessions: SessionInfoLite[],
  title: string,
  ctx: { ui: { select: (title: string, options: string[]) => Promise<string | undefined> } },
): Promise<SessionInfoLite | undefined> {
  const top = sessions.slice(0, 40);
  const options = top.map(optionLabel);
  const selected = await ctx.ui.select(title, options);
  if (!selected) return undefined;
  const index = options.indexOf(selected);
  if (index < 0) return undefined;
  return top[index];
}

type PickerKind = "slash" | "file" | "bash";

type PickerItem = {
  label: string;
  value: string;
};

type PickerState = {
  kind: PickerKind | "thread";
  prefix: string;
  items: PickerItem[];
  selected: number;
};

class ThreadReferenceEditor extends CustomEditor {
  private suppressDetection = false;
  private picker: PickerState | undefined;

  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    private readonly getSlashSuggestions: (query: string) => string[],
    private readonly getFileSuggestions: (query: string) => string[],
    private readonly getThreadSuggestions: (query: string) => PickerItem[],
    private readonly getBashSuggestions: (query: string) => string[],
  ) {
    super(tui, theme, keybindings);
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  private cursorOffset(): number {
    const cursor = this.getCursor();
    const lines = this.getLines();
    let offset = 0;
    for (let i = 0; i < cursor.line; i++) {
      offset += (lines[i] || "").length + 1;
    }
    return offset + cursor.col;
  }

  private updatePickerState(): void {
    const beforeCursor = this.getText().slice(0, this.cursorOffset());

    const slashMatch = beforeCursor.match(/(?:^|\s)(\/[\w:-]*)$/);
    if (slashMatch) {
      const prefix = slashMatch[1] || "/";
      const query = prefix.slice(1);
      const items = this.getSlashSuggestions(query)
        .slice(0, PICKER_MAX_ITEMS)
        .map((value) => ({ label: value, value }));
      this.picker = items.length > 0 ? { kind: "slash", prefix, items, selected: 0 } : undefined;
      return;
    }

    const threadMatch = beforeCursor.match(/(?:^|\s)(@@[\w.-]*)$/);
    if (threadMatch) {
      const prefix = threadMatch[1] || "@@";
      const query = prefix.slice(2);
      const items = this.getThreadSuggestions(query).slice(0, PICKER_MAX_ITEMS);
      this.picker = items.length > 0 ? { kind: "thread", prefix, items, selected: 0 } : undefined;
      return;
    }

    const fileMatch = beforeCursor.match(/(?:^|\s)(@[^@\s]*)$/);
    if (fileMatch) {
      const prefix = fileMatch[1] || "@";
      const query = prefix.slice(1);
      const items = this.getFileSuggestions(query)
        .slice(0, PICKER_MAX_ITEMS)
        .map((value) => ({ label: value, value }));
      this.picker = items.length > 0 ? { kind: "file", prefix, items, selected: 0 } : undefined;
      return;
    }

    // !query -> bash command picker (exclude !! no-context shorthand)
    const bashMatch = beforeCursor.match(/(?:^|\s)(!(?!\!)[^\s]*)$/);
    if (bashMatch) {
      const prefix = bashMatch[1] || "!";
      const query = prefix.slice(1);
      const items = this.getBashSuggestions(query)
        .slice(0, PICKER_MAX_ITEMS)
        .map((value) => ({ label: `!${value}`, value }));
      this.picker = items.length > 0 ? { kind: "bash", prefix, items, selected: 0 } : undefined;
      return;
    }

    this.picker = undefined;
  }

  private replaceTypedPrefix(prefix: string, replacement: string): void {
    this.suppressDetection = true;
    for (let i = 0; i < prefix.length; i++) {
      super.handleInput("\x7f");
    }
    this.insertTextAtCursor(replacement);
    this.suppressDetection = false;
  }

  private applyPickerSelection(options?: { submitAfter?: boolean }): void {
    if (!this.picker) return;
    const picker = this.picker;
    const item = picker.items[picker.selected];
    if (!item) return;

    if (picker.kind === "thread") {
      this.replaceTypedPrefix(picker.prefix, `[[thread:${item.value}]] `);
      showTransientBadge("THREAD INSERTED");
      this.picker = undefined;
      return;
    }

    if (picker.kind === "slash") {
      this.replaceTypedPrefix(picker.prefix, item.value);
      this.picker = undefined;
      if (options?.submitAfter) {
        super.handleInput("\r");
      }
      return;
    }

    if (picker.kind === "bash") {
      const suffix = options?.submitAfter ? "" : " ";
      this.replaceTypedPrefix(picker.prefix, `!${item.value}${suffix}`);
      this.picker = undefined;
      if (options?.submitAfter) {
        super.handleInput("\r");
      }
      return;
    }

    // file picker
    this.replaceTypedPrefix(picker.prefix, `${item.value} `);
    this.picker = undefined;
  }

  override render(width: number): string[] {
    const margin = panelMargin(width);
    const panelWidth = Math.max(24, width - margin * 2);
    const panelInside = Math.max(10, panelWidth - 2);

    const logicalLines = this.getLines();
    const cursor = this.getCursor();

    const interior: string[] = [];
    for (let i = 0; i < logicalLines.length; i++) {
      const line = logicalLines[i] || "";
      const wrapped = wrapPlainText(line, panelInside);

      let cursorChunkIndex = -1;
      let cursorColInChunk = 0;
      if (this.focused && i === cursor.line) {
        const safeCol = Math.max(0, cursor.col);
        cursorChunkIndex = Math.floor(safeCol / panelInside);
        if (cursorChunkIndex >= wrapped.length) cursorChunkIndex = wrapped.length - 1;
        if (cursorChunkIndex < 0) cursorChunkIndex = 0;
        cursorColInChunk = safeCol - cursorChunkIndex * panelInside;
      }

      for (let chunkIndex = 0; chunkIndex < wrapped.length; chunkIndex++) {
        const chunk = wrapped[chunkIndex] || "";
        if (this.focused && i === cursor.line && chunkIndex === cursorChunkIndex) {
          interior.push(`│${paintCursorBlock(chunk, panelInside, cursorColInChunk)}│`);
        } else {
          interior.push(`│${fitToWidth(chunk, panelInside)}│`);
        }
      }
    }

    while (interior.length < 3) {
      interior.push(`│${" ".repeat(panelInside)}│`);
    }

    const top = `╭${"─".repeat(panelInside)}╮`;

    const badge = getTransientBadge();
    const badgeLabel = badge ? ` ${badge} ` : "";
    let bottomInside = "─".repeat(panelInside);
    if (badgeLabel && badgeLabel.length < panelInside) {
      bottomInside = "─".repeat(panelInside - badgeLabel.length) + badgeLabel;
    }
    const bottom = `╰${bottomInside}╯`;

    const pad = " ".repeat(margin);
    const lines = [top, ...interior, bottom].map((line) => `${pad}${line}${pad}`);

    if (this.picker && this.picker.items.length > 0) {
      const pickerWidth = panelWidth;
      const inside = Math.max(8, pickerWidth - 2);
      const pickerTop = `${pad}╭${"─".repeat(inside)}╮${pad}`;
      const pickerBottom = `${pad}╰${"─".repeat(inside)}╯${pad}`;
      const pickerRows = this.picker.items.map((it, index) => {
        const selected = index === this.picker!.selected;
        const marker = selected ? "› " : "  ";
        const text = fitToWidth(`${marker}${it.label}`, inside);
        const painted = selected ? `\x1b[7m${text}\x1b[27m` : text;
        return `${pad}│${painted}│${pad}`;
      });

      lines.push(pickerTop, ...pickerRows, pickerBottom);
    }

    return lines;
  }

  override handleInput(data: string): void {
    if (this.picker) {
      if (isArrowUp(data)) {
        this.picker.selected = Math.max(0, this.picker.selected - 1);
        this.tui.requestRender();
        return;
      }
      if (isArrowDown(data)) {
        this.picker.selected = Math.min(this.picker.items.length - 1, this.picker.selected + 1);
        this.tui.requestRender();
        return;
      }
      if (isTab(data)) {
        this.applyPickerSelection({ submitAfter: false });
        this.tui.requestRender();
        return;
      }
      if (isEnter(data)) {
        this.applyPickerSelection({ submitAfter: this.picker.kind === "slash" || this.picker.kind === "bash" });
        this.tui.requestRender();
        return;
      }
      if (isEscape(data)) {
        this.picker = undefined;
        this.tui.requestRender();
        return;
      }

      // Any other input: dismiss picker first, then type the character.
      // updatePickerState() below may re-open a picker based on new text.
      this.picker = undefined;
    }

    super.handleInput(data);

    if (!this.suppressDetection) {
      this.updatePickerState();
    }
    this.tui.requestRender();
  }
}

export default function threadReferencesExtension(pi: ExtensionAPI) {
  let fileIndex: string[] = [];
  let threadIndex: SessionInfoLite[] = [];
  let bashHistory: string[] = [];
  let builtInCommands: string[] = [...FALLBACK_BUILT_IN_COMMANDS];
  let installedEditorSessionId: string | undefined;

  const normalizeBashCommand = (raw: string): string => {
    const text = (raw || "").trim();
    if (!text) return "";
    const withoutBang = text.startsWith("!") ? text.slice(1).trim() : text;
    return withoutBang.replace(/\s+/g, " ").trim();
  };

  const refreshBashHistory = (ctx: any): void => {
    const context = ctx.sessionManager?.buildSessionContext?.();
    const msgs = Array.isArray(context?.messages) ? context.messages : [];
    const seen = new Set<string>();
    const next: string[] = [];

    for (const msg of msgs) {
      if (!msg || msg.role !== "bashExecution") continue;

      const fromField = typeof (msg as { command?: unknown }).command === "string"
        ? String((msg as { command?: unknown }).command)
        : "";
      const fromText = messageText(msg as AgentMessage);
      const parsed = normalizeBashCommand(fromField || fromText);
      if (!parsed || seen.has(parsed)) continue;
      seen.add(parsed);
      next.push(parsed);
    }

    // prefer most-recent first
    bashHistory = next.reverse();
  };

  const pushBashHistory = (command: string): void => {
    const parsed = normalizeBashCommand(command);
    if (!parsed) return;
    bashHistory = [parsed, ...bashHistory.filter((c) => c !== parsed)].slice(0, 200);
  };

  const getSlashSuggestions = (query: string): string[] => {
    const extensionCommands = pi.getCommands().map((c) => c.name);
    const all = Array.from(new Set([...builtInCommands, ...extensionCommands])).map((n) => `/${n}`);
    return all
      .map((value) => ({ value, score: scoreMatch(value.slice(1), query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
      .map((x) => x.value);
  };

  const getFileSuggestions = (query: string): string[] => {
    const norm = query.replace(/^@/, "").toLowerCase();
    return fileIndex
      .map((p) => ({ value: `@${p}`, score: scoreMatch(p.toLowerCase(), norm) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
      .map((x) => x.value);
  };

  const getThreadSuggestions = (query: string): PickerItem[] => {
    const q = query.trim().toLowerCase();
    const rows = threadIndex
      .map((s) => {
        const title = threadTitle(s);
        const id8 = s.id.slice(0, 8);
        const haystack = `${title} ${id8} ${s.cwd}`.toLowerCase();
        const score = q ? scoreMatch(haystack, q) : 1;
        return { s, title, id8, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.s.modified.getTime() - a.s.modified.getTime())
      .slice(0, PICKER_MAX_ITEMS)
      .map((x) => ({ label: `${x.title}  ·  ${x.id8}`, value: x.id8 }));

    return rows;
  };

  const getBashSuggestions = (query: string): string[] => {
    const q = query.trim().toLowerCase();
    return bashHistory
      .map((cmd) => ({ cmd, score: scoreMatch(cmd.toLowerCase(), q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.cmd);
  };

  const installThreadAtEditor = async (ctx: any): Promise<void> => {
    builtInCommands = await discoverBuiltInCommands();
    fileIndex = await scanFiles(ctx.cwd);
    threadIndex = await listSessions(ctx.sessionManager.getSessionFile());
    refreshBashHistory(ctx);

    ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
      const editor = new ThreadReferenceEditor(
        tui,
        theme,
        keybindings,
        getSlashSuggestions,
        getFileSuggestions,
        getThreadSuggestions,
        getBashSuggestions,
      );
      requestEditorRender = () => editor.requestRender();
      return editor;
    });
  };

  const ensureEditorInstalled = async (ctx: any): Promise<void> => {
    if (!ctx.hasUI) return;
    const sid = ctx.sessionManager?.getSessionId?.();
    if (sid && installedEditorSessionId === sid) return;
    await installThreadAtEditor(ctx);
    installedEditorSessionId = sid;
  };

  pi.on("session_start", async (_event, ctx) => {
    await ensureEditorInstalled(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await ensureEditorInstalled(ctx);
  });

  // Defensive: in some reload flows the editor hook may not reattach until a turn starts.
  pi.on("agent_start", async (_event, ctx) => {
    await ensureEditorInstalled(ctx);
  });

  pi.on("user_bash", async (event, ctx) => {
    if (typeof event.command === "string" && event.command.trim()) {
      pushBashHistory(event.command);
      requestEditorRender?.();
    } else {
      refreshBashHistory(ctx);
      requestEditorRender?.();
    }
  });

  pi.events.on("thread:handoff", (data?: { stay?: boolean }) => {
    showTransientBadge(data?.stay ? "HANDOFF CREATED" : "HANDOFF SWITCHED");
  });

  pi.registerCommand("threads", {
    description: "List other sessions and insert a [[thread:<id>]] reference",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      const currentSessionPath = ctx.sessionManager.getSessionFile();
      const sessions = (await listSessions(currentSessionPath)).filter((s) =>
        query ? matchesQuery(s, query) : true,
      );

      if (sessions.length === 0) {
        ctx.ui.notify("No matching threads found", "warning");
        return;
      }

      const chosen = await pickSession(sessions, "Insert thread reference", ctx);
      if (!chosen) return;

      const token = `[[thread:${chosen.id.slice(0, 8)}]]`;
      ctx.ui.pasteToEditor(`${token} `);
      showTransientBadge("THREAD INSERTED");
      ctx.ui.notify(`Inserted ${token}`, "info");
    },
  });

  pi.registerCommand("switch", {
    description: "Switch to another thread/session",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      const currentSessionPath = ctx.sessionManager.getSessionFile();
      const sessions = (await listSessions(currentSessionPath)).filter((s) =>
        query ? matchesQuery(s, query) : true,
      );

      if (sessions.length === 0) {
        ctx.ui.notify("No matching threads found", "warning");
        return;
      }

      const chosen = await pickSession(sessions, "Switch to thread", ctx);
      if (!chosen) return;

      const result = await ctx.switchSession(chosen.path);
      if (result.cancelled) return;

      showTransientBadge("THREAD SWITCHED");
      ctx.ui.notify(`Switched to ${threadTitle(chosen)} (${chosen.id.slice(0, 8)})`, "info");
    },
  });

  const manageHandler = async (args: string | undefined, ctx: any) => {
    const query = (args || "").trim();
    const currentSessionPath = ctx.sessionManager.getSessionFile();
    const sessions = (await listSessions(currentSessionPath, true)).filter((s) =>
      query ? matchesQuery(s, query) : true,
    );

    if (sessions.length === 0) {
      ctx.ui.notify("No matching threads found", "warning");
      return;
    }

    const chosen = await pickSession(sessions, "Manage thread", ctx);
    if (!chosen) return;

    const isCurrent = currentSessionPath && chosen.path === currentSessionPath;
    const action = await ctx.ui.select("Action", ["Rename", "Delete"]);
    if (!action) return;

    if (action === "Rename") {
      const suggested = chosen.name?.trim() || threadTitle(chosen);
      const value = await ctx.ui.input("New thread name", suggested);
      const name = (value || "").trim();
      if (!name) return;

      if (isCurrent) {
        pi.setSessionName(name);
      } else {
        const sm = SessionManager.open(chosen.path);
        sm.appendSessionInfo(name);
      }

      showTransientBadge("THREAD RENAMED");
      ctx.ui.notify(`Renamed thread to \"${name}\"`, "info");
      return;
    }

    if (action === "Delete") {
      if (isCurrent) {
        ctx.ui.notify("Cannot delete the currently active thread", "warning");
        return;
      }

      const ok = await ctx.ui.confirm(
        "Delete thread?",
        `Permanently delete \"${threadTitle(chosen)}\" (${chosen.id.slice(0, 8)})?`,
      );
      if (!ok) return;

      await rm(chosen.path);
      showTransientBadge("THREAD DELETED");
      ctx.ui.notify("Thread deleted", "info");
    }
  };

  pi.registerCommand("threads:manage", {
    description: "Rename or delete a thread",
    handler: manageHandler,
  });

  pi.registerCommand("threads-manage", {
    description: "Alias for /threads:manage",
    handler: manageHandler,
  });

  pi.on("input", async (event, ctx) => {
    let transformed = event.text;
    const notes: string[] = [];
    let hadThreadAction = false;

    // @@query -> interactive thread picker, replaced with [[thread:<id>]]
    const atMarkers = [...transformed.matchAll(/(^|\s)@@([\w.-]*)/g)];
    if (atMarkers.length > 0) {
      if (!ctx.hasUI) {
        notes.push("Skipped @@ thread references: UI not available in this mode.");
      } else {
        const currentSessionPath = ctx.sessionManager.getSessionFile();
        const sessions = await listSessions(currentSessionPath);
        const limitedMarkers = atMarkers.slice(0, MAX_REFERENCES_PER_PROMPT);

        for (const match of limitedMarkers) {
          const prefix = match[1] || "";
          const query = (match[2] || "").trim();
          const candidates = sessions.filter((s) => (query ? matchesQuery(s, query) : true));

          if (candidates.length === 0) {
            notes.push(`Skipped @@${query}: no matching threads`);
            continue;
          }

          let chosen: SessionInfoLite | undefined;
          if (candidates.length === 1) {
            chosen = candidates[0];
          } else {
            chosen = await pickSession(candidates, `Select thread for @@${query || ""}`, ctx);
          }

          if (!chosen) {
            notes.push(`Skipped @@${query}: selection cancelled`);
            continue;
          }

          const marker = `${prefix}@@${query}`;
          const replacement = `${prefix}[[thread:${chosen.id.slice(0, 8)}]]`;
          transformed = transformed.replace(marker, replacement);
          hadThreadAction = true;
          notes.push(`Resolved @@${query || ""} -> ${chosen.id.slice(0, 8)}`);
        }

        if (atMarkers.length > MAX_REFERENCES_PER_PROMPT) {
          notes.push(`Only first ${MAX_REFERENCES_PER_PROMPT} @@ references were processed.`);
        }
      }
    }

    const matches = [...transformed.matchAll(/\[\[thread:([^\]]+)\]\]/gi)];
    if (matches.length === 0) {
      if (hadThreadAction) showTransientBadge("THREAD TOKEN READY");
      if (notes.length > 0) ctx.ui.notify(notes.join(" | "), "info");
      return { action: "transform", text: transformed };
    }

    const uniqueTokens = Array.from(new Set(matches.map((m) => (m[1] || "").trim()))).slice(
      0,
      MAX_REFERENCES_PER_PROMPT,
    );

    const currentSessionPath = ctx.sessionManager.getSessionFile();
    const sessions = await listSessions(currentSessionPath);

    for (const token of uniqueTokens) {
      const placeholder = `[[thread:${token}]]`;
      const resolved = resolveToken(token, sessions);

      if (!resolved.session) {
        notes.push(`Skipped ${placeholder}: ${resolved.error || "unknown error"}`);
        continue;
      }

      const block = buildReferenceBlock(resolved.session);
      const replacement = `\n\n${block}\n\n`;
      transformed = transformed.split(placeholder).join(replacement);
      hadThreadAction = true;
      notes.push(`Expanded ${placeholder} -> ${resolved.session.id.slice(0, 8)}`);
    }

    if (matches.length > MAX_REFERENCES_PER_PROMPT) {
      notes.push(`Only first ${MAX_REFERENCES_PER_PROMPT} thread references were expanded.`);
    }

    if (hadThreadAction) showTransientBadge("THREAD CONTEXT ATTACHED");

    if (notes.length > 0) {
      ctx.ui.notify(notes.join(" | "), "info");
    }

    return { action: "transform", text: transformed };
  });
}
