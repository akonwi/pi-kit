import { appendFile, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { SessionManager, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type SessionInfoLite = {
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
export const PICKER_MAX_ITEMS = 8;
const PICKER_MAX_FILES = 4000;
const DEFAULT_FILE_SCAN_EXCLUDES = [".git", "node_modules", ".pi", ".agents", "dist", "build"];
const FILE_PICKER_IGNORE_FILE = ".pi-ignore";
export const FALLBACK_BUILT_IN_COMMANDS = [
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

export function setThreadReferenceRenderRequest(next: (() => void) | undefined): void {
  requestEditorRender = next;
}

export function requestThreadReferenceRender(): void {
  requestEditorRender?.();
}

export function showTransientBadge(text: string): void {
  transientBadgeText = text;
  transientBadgeUntil = Date.now() + BADGE_DURATION_MS;
  requestEditorRender?.();

  setTimeout(() => {
    if (Date.now() >= transientBadgeUntil) {
      requestEditorRender?.();
    }
  }, BADGE_DURATION_MS + 20);
}

export function getTransientBadge(): string | undefined {
  if (!transientBadgeText) return undefined;
  if (Date.now() >= transientBadgeUntil) return undefined;
  return transientBadgeText;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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

export function scoreMatch(value: string, query: string): number {
  if (!query) return 1;
  const v = value.toLowerCase();
  const q = query.toLowerCase();
  if (v === q) return 100;
  if (v.startsWith(q)) return 85;
  if (v.includes(q)) return 60;

  // Fuzzy subsequence fallback (e.g. "thream" -> "threads-manage").
  return subsequenceScore(v, q);
}

export async function discoverBuiltInCommands(): Promise<string[]> {
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

type IgnoreRule = {
  raw: string;
  directoryOnly: boolean;
  hasSlash: boolean;
};

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

function stripComment(line: string): string {
  return line.trim();
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function compileIgnoreRules(lines: string[]): IgnoreRule[] {
  return lines
    .map((line) => stripComment(line))
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const directoryOnly = line.endsWith("/");
      const raw = normalizeRelativePath(directoryOnly ? line.slice(0, -1) : line);
      return {
        raw,
        directoryOnly,
        hasSlash: raw.includes("/"),
      } satisfies IgnoreRule;
    })
    .filter((rule) => rule.raw.length > 0);
}

async function loadIgnoreRules(cwd: string): Promise<IgnoreRule[]> {
  const builtIns = compileIgnoreRules(DEFAULT_FILE_SCAN_EXCLUDES.map((name) => `${name}/`));
  const ignorePath = path.join(cwd, FILE_PICKER_IGNORE_FILE);

  try {
    const content = await readFile(ignorePath, "utf8");
    const custom = compileIgnoreRules(content.split(/\r?\n/g));
    return [...builtIns, ...custom];
  } catch {
    return builtIns;
  }
}

function matchesIgnoreRule(relativePath: string, rule: IgnoreRule, isDirectory: boolean): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return false;

  if (rule.directoryOnly && !isDirectory && !normalized.startsWith(`${rule.raw}/`)) {
    return false;
  }

  if (!rule.hasSlash) {
    const segmentRegex = wildcardToRegExp(rule.raw);
    const segments = normalized.split("/");

    if (rule.directoryOnly) {
      return segments.some((segment) => segmentRegex.test(segment));
    }

    return segments.some((segment) => segmentRegex.test(segment));
  }

  const pathRegex = wildcardToRegExp(rule.raw);
  if (pathRegex.test(normalized)) return true;
  return rule.directoryOnly && normalized.startsWith(`${rule.raw}/`);
}

function isWithinDir(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function findNearestIgnoreFile(baseDir: string, targetPath: string): Promise<string> {
  let current = targetPath;
  while (isWithinDir(current, baseDir)) {
    const candidate = path.join(current, FILE_PICKER_IGNORE_FILE);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // continue upward
    }

    if (current === baseDir) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return path.join(baseDir, FILE_PICKER_IGNORE_FILE);
}

function normalizeIgnoreEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#")) return "";
  const directoryOnly = trimmed.endsWith("/");
  const normalized = normalizeRelativePath(directoryOnly ? trimmed.slice(0, -1) : trimmed);
  return directoryOnly ? `${normalized}/` : normalized;
}

async function appendIgnoreEntry(baseDir: string, targetPath: string, isDirectory: boolean): Promise<{ ignoreFile: string; entry: string; created: boolean; duplicate: boolean }> {
  const anchorDir = isDirectory ? targetPath : path.dirname(targetPath);
  const ignoreFile = await findNearestIgnoreFile(baseDir, anchorDir);
  const ignoreDir = path.dirname(ignoreFile);
  const relative = normalizeRelativePath(path.relative(ignoreDir, targetPath));
  const entry = isDirectory ? `${relative}/` : relative;

  let existing = "";
  let created = false;
  try {
    existing = await readFile(ignoreFile, "utf8");
  } catch {
    created = true;
  }

  const existingEntries = new Set(
    existing
      .split(/\r?\n/g)
      .map((line) => normalizeIgnoreEntry(line))
      .filter(Boolean),
  );

  if (existingEntries.has(entry)) {
    return { ignoreFile, entry, created: false, duplicate: true };
  }

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const payload = `${needsLeadingNewline ? "\n" : ""}${entry}\n`;
  await appendFile(ignoreFile, payload, "utf8");
  return { ignoreFile, entry, created, duplicate: false };
}

type IgnoreEntryRecord = {
  ignoreFile: string;
  entry: string;
};

async function listIgnoreEntriesInFile(ignoreFile: string): Promise<IgnoreEntryRecord[]> {
  try {
    const content = await readFile(ignoreFile, "utf8");
    return content
      .split(/\r?\n/g)
      .map((line) => normalizeIgnoreEntry(line))
      .filter(Boolean)
      .map((entry) => ({ ignoreFile, entry }));
  } catch {
    return [];
  }
}

async function removeIgnoreEntryFromFile(ignoreFile: string, entry: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(ignoreFile, "utf8");
  } catch {
    return false;
  }

  const lines = content.split(/\r?\n/g);
  const kept = lines.filter((line) => normalizeIgnoreEntry(line) !== entry);
  if (kept.length === lines.length) return false;

  const serialized = `${kept.join("\n").replace(/\n+$/g, "")}\n`;
  await writeFile(ignoreFile, serialized, "utf8");
  return true;
}

async function removeIgnoreEntryByPath(baseDir: string, targetPath: string): Promise<{ ignoreFile?: string; entry?: string; removed: boolean }> {
  const searchDirs: string[] = [];

  let current = targetPath;
  while (isWithinDir(current, baseDir)) {
    searchDirs.push(current);
    if (current === baseDir) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const candidates = Array.from(new Set([
    ...searchDirs.flatMap((dir) => {
      const relToDir = normalizeRelativePath(path.relative(dir, targetPath));
      return [relToDir, `${relToDir}/`].filter(Boolean);
    }),
    normalizeRelativePath(path.relative(baseDir, targetPath)),
    `${normalizeRelativePath(path.relative(baseDir, targetPath))}/`,
  ].filter(Boolean)));

  for (const dir of searchDirs) {
    const ignoreFile = path.join(dir, FILE_PICKER_IGNORE_FILE);
    const entries = await listIgnoreEntriesInFile(ignoreFile);
    for (const candidate of candidates) {
      if (entries.some((item) => item.entry === candidate)) {
        const removed = await removeIgnoreEntryFromFile(ignoreFile, candidate);
        if (removed) return { ignoreFile, entry: candidate, removed: true };
      }
    }
  }

  return { removed: false };
}

async function scanIgnoreFiles(cwd: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_FILE_SCAN_EXCLUDES.includes(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (entry.isFile() && entry.name === FILE_PICKER_IGNORE_FILE) {
        found.push(full);
      }
    }
  }

  await walk(cwd);
  return found.sort((a, b) => a.localeCompare(b));
}

async function scanPathPickerItems(cwd: string): Promise<Array<{ label: string; value: string }>> {
  const files: string[] = [];
  const dirs = new Set<string>();
  const ignoreRules = await loadIgnoreRules(cwd);

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
      const relative = normalizeRelativePath(path.relative(cwd, full));

      if (entry.isDirectory()) {
        if (ignoreRules.some((rule) => matchesIgnoreRule(relative, rule, true))) continue;
        if (relative) dirs.add(`${relative}/`);
        await walk(full);
        continue;
      }

      if (!entry.isFile()) continue;
      if (relative === FILE_PICKER_IGNORE_FILE) continue;
      if (ignoreRules.some((rule) => matchesIgnoreRule(relative, rule, false))) continue;
      files.push(relative);
    }
  }

  await walk(cwd);

  const dirItems = Array.from(dirs)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ label: `dir  ${value}`, value }));
  const fileItems = files
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ label: `file ${value}`, value }));

  return [...dirItems, ...fileItems];
}

export async function scanFiles(cwd: string): Promise<string[]> {
  const paths: string[] = [];
  const ignoreRules = await loadIgnoreRules(cwd);

  async function walk(dir: string): Promise<void> {
    if (paths.length >= PICKER_MAX_FILES) return;

    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (paths.length >= PICKER_MAX_FILES) return;
      const full = path.join(dir, entry.name);
      const relative = normalizeRelativePath(path.relative(cwd, full));

      if (entry.isDirectory()) {
        if (ignoreRules.some((rule) => matchesIgnoreRule(relative, rule, true))) continue;
        if (relative) paths.push(`${relative}/`);
        await walk(full);
        continue;
      }

      if (!entry.isFile()) continue;
      if (ignoreRules.some((rule) => matchesIgnoreRule(relative, rule, false))) continue;
      paths.push(relative);
    }
  }

  await walk(cwd);
  return paths;
}

export function messageText(msg: AgentMessage): string {
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

export async function listSessions(currentSessionPath?: string, includeCurrent = false): Promise<SessionInfoLite[]> {
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

export function threadTitle(s: SessionInfoLite): string {
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

export default function threadReferencesExtension(pi: ExtensionAPI) {
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

  const choosePathToIgnore = async (ctx: any): Promise<string | null | undefined> => {
    if (!ctx.hasUI || typeof ctx.ui.select !== "function") return null;
    const items = await scanPathPickerItems(ctx.cwd);
    if (items.length === 0) return null;
    const labels = items.slice(0, 4000).map((item) => item.label);
    const selected = await ctx.ui.select("Ignore file or directory", labels);
    if (!selected) return undefined;
    return items.find((item) => item.label === selected)?.value;
  };

  const chooseIgnoreEntryToRemove = async (ctx: any): Promise<IgnoreEntryRecord | null | undefined> => {
    if (!ctx.hasUI || typeof ctx.ui.select !== "function") return null;
    const ignoreFiles = await scanIgnoreFiles(ctx.cwd);
    const entries = (await Promise.all(ignoreFiles.map((ignoreFile) => listIgnoreEntriesInFile(ignoreFile))))
      .flat()
      .sort((a, b) => {
        const fileCmp = a.ignoreFile.localeCompare(b.ignoreFile);
        return fileCmp !== 0 ? fileCmp : a.entry.localeCompare(b.entry);
      });
    if (entries.length === 0) return null;

    const labels = entries.map((item) => {
      const location = path.relative(ctx.cwd, item.ignoreFile) || FILE_PICKER_IGNORE_FILE;
      return `${location}  ·  ${item.entry}`;
    });
    const selected = await ctx.ui.select("Unignore entry", labels);
    if (!selected) return undefined;
    const index = labels.indexOf(selected);
    return index >= 0 ? entries[index] : undefined;
  };

  const refreshFileIndex = async (ctx: any): Promise<void> => {
    fileIndex = await scanFiles(ctx.cwd);
    requestEditorRender?.();
  };

  const fileIgnoreHandler = async (args: string | undefined, ctx: any) => {
    let raw = (args || "").trim();
    if (!raw) {
      const picked = await choosePathToIgnore(ctx);
      if (picked === undefined) return;
      raw = picked || "";
    }
    if (!raw && ctx.hasUI && typeof ctx.ui.input === "function") {
      raw = String(await ctx.ui.input("Ignore file or directory", "") || "").trim();
    }

    if (!raw) {
      ctx.ui.notify("Usage: /files:ignore <path>", "warning");
      return;
    }

    const cleaned = raw.replace(/^@/, "").trim().replace(/\/$/, "");
    const absolute = path.resolve(ctx.cwd, cleaned);

    if (!isWithinDir(absolute, ctx.cwd)) {
      ctx.ui.notify("Path must be inside the current session directory", "warning");
      return;
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch {
      ctx.ui.notify(`Path not found: ${cleaned}`, "warning");
      return;
    }

    if (!info.isFile() && !info.isDirectory()) {
      ctx.ui.notify("Only files and directories can be ignored", "warning");
      return;
    }

    const result = await appendIgnoreEntry(ctx.cwd, absolute, info.isDirectory());
    await refreshFileIndex(ctx);

    if (result.duplicate) {
      ctx.ui.notify(`Already ignored in ${path.relative(ctx.cwd, result.ignoreFile) || FILE_PICKER_IGNORE_FILE}`, "info");
      return;
    }

    const location = path.relative(ctx.cwd, result.ignoreFile) || FILE_PICKER_IGNORE_FILE;
    const status = result.created ? "Created" : "Updated";
    ctx.ui.notify(`${status} ${location} with ${result.entry}`, "info");
    showTransientBadge("FILES IGNORED");
  };

  const fileUnignoreHandler = async (args: string | undefined, ctx: any) => {
    let raw = (args || "").trim();

    if (!raw) {
      const chosen = await chooseIgnoreEntryToRemove(ctx);
      if (chosen === undefined) return;
      if (chosen === null) {
        ctx.ui.notify("No ignore entries found", "warning");
        return;
      }

      const removed = await removeIgnoreEntryFromFile(chosen.ignoreFile, chosen.entry);
      if (!removed) {
        ctx.ui.notify("Ignore entry was not found", "warning");
        return;
      }

      await refreshFileIndex(ctx);
      const location = path.relative(ctx.cwd, chosen.ignoreFile) || FILE_PICKER_IGNORE_FILE;
      ctx.ui.notify(`Removed ${chosen.entry} from ${location}`, "info");
      showTransientBadge("FILES UNIGNORED");
      return;
    }

    const cleaned = raw.replace(/^@/, "").trim().replace(/\/$/, "");
    const absolute = path.resolve(ctx.cwd, cleaned);

    if (!isWithinDir(absolute, ctx.cwd)) {
      ctx.ui.notify("Path must be inside the current session directory", "warning");
      return;
    }

    const result = await removeIgnoreEntryByPath(ctx.cwd, absolute);
    if (!result.removed || !result.ignoreFile || !result.entry) {
      ctx.ui.notify(`No ignore entry found for ${cleaned}`, "warning");
      return;
    }

    await refreshFileIndex(ctx);
    const location = path.relative(ctx.cwd, result.ignoreFile) || FILE_PICKER_IGNORE_FILE;
    ctx.ui.notify(`Removed ${result.entry} from ${location}`, "info");
    showTransientBadge("FILES UNIGNORED");
  };

  pi.registerCommand("files:ignore", {
    description: "Add a file or directory to the nearest .pi-files-ignore",
    handler: fileIgnoreHandler,
  });

  pi.registerCommand("files-ignore", {
    description: "Alias for /files:ignore",
    handler: fileIgnoreHandler,
  });

  pi.registerCommand("files:unignore", {
    description: "Remove a file or directory from .pi-files-ignore",
    handler: fileUnignoreHandler,
  });

  pi.registerCommand("files-unignore", {
    description: "Alias for /files:unignore",
    handler: fileUnignoreHandler,
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
