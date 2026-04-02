/**
 * Thread references extension — `@@id` syntax for thread context.
 *
 * Provides:
 * - `/threads` command to browse and insert thread references
 * - `@@id` expansion to thread context in user input
 * - `/files:ignore` and `/files:unignore` for .pi-ignore management
 */

import { appendFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
const FILE_PICKER_IGNORE_FILE = ".pi-ignore";
const LEGACY_FILE_PICKER_IGNORE_FILE = ".pi-files-ignore";
const DEFAULT_FILE_SCAN_EXCLUDES = [".git", "node_modules", ".pi", ".agents", "dist", "build"];

// --- Helpers ---

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
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

// --- Session listing ---

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

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function sessionDirLabel(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const normalized = cwd.startsWith(home)
    ? `~${cwd.slice(home.length)}`
    : cwd;
  return normalized.split("/").pop() || normalized;
}

export function formatSessionOptionLite(s: SessionInfoLite): { label: string; description: string } {
  return {
    label: threadTitle(s),
    description: `${sessionDirLabel(s.cwd)}  ·  ${formatTimeAgo(s.modified)}  ·  ${s.id.slice(0, 8)}`,
  };
}

// --- Thread reference resolution ---

function resolveThreadToken(token: string, sessions: SessionInfoLite[]): { session?: SessionInfoLite; error?: string } {
  const key = token.trim().toLowerCase();
  if (!key) return { error: "empty thread reference" };

  // Try exact ID match first
  const byExactId = sessions.find((s) => s.id.toLowerCase() === key);
  if (byExactId) return { session: byExactId };

  // Try ID prefix match
  const byIdPrefix = sessions.filter((s) => s.id.toLowerCase().startsWith(key));
  if (byIdPrefix.length === 1) return { session: byIdPrefix[0] };
  if (byIdPrefix.length > 1) {
    const ids = byIdPrefix.slice(0, 3).map((s) => s.id.slice(0, 8)).join(", ");
    return { error: `ambiguous: ${ids}${byIdPrefix.length > 3 ? "..." : ""}` };
  }

  // Try name/content match
  const byNameContains = sessions.filter((s) =>
    `${s.name || ""} ${s.firstMessage || ""}`.toLowerCase().includes(key),
  );
  if (byNameContains.length === 1) return { session: byNameContains[0] };
  if (byNameContains.length > 1) {
    return { error: `ambiguous name match` };
  }

  return { error: `thread not found` };
}

function buildThreadContextBlock(session: SessionInfoLite): string {
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
      `[Thread Context]`,
      `id: ${session.id}`,
      `title: ${threadTitle(session)}`,
      `cwd: ${session.cwd || "(unknown)"}`,
      `updated: ${session.modified.toISOString()}`,
      `---`,
    ];

    const body = tail.map((m) => `${m.role}: ${m.text}`);
    return [...header, ...body].join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `[Thread Context]\nid: ${session.id}\nerror: ${msg}`;
  }
}

// --- Extension ---

export default function threadReferencesExtension(pi: ExtensionAPI) {
  // Thread picker for /threads command
  pi.registerCommand("threads", {
    description: "Browse threads and insert a thread reference",
    handler: async (args, ctx) => {
      const query = String(args || "").trim();
      const currentPath = ctx.sessionManager.getSessionFile();
      const sessions = await listSessions(currentPath, false);

      const filtered = query
        ? sessions.filter((s) => matchesQuery(s, query))
        : sessions;

      if (filtered.length === 0) {
        ctx.ui.notify("No threads found", "warning");
        return;
      }

      const options = filtered.slice(0, 20).map((s) => {
        const { label, description } = formatSessionOptionLite(s);
        return `${label}  ·  ${description}`;
      });

      const choice = await ctx.ui.select("Select thread", options);
      if (choice === undefined) return;

      const index = options.indexOf(choice);
      if (index < 0) return;

      const chosen = filtered[index];
      const token = `@@${chosen.id.slice(0, 8)}`;

      // Insert the thread reference at cursor
      ctx.ui.pasteToEditor(`${token} `);
      ctx.ui.notify(`Inserted ${token}`, "info");
    },
  });

  // Input handler: expand @@id references
  pi.on("input", async (event, ctx) => {
    let transformed = event.text;
    const notes: string[] = [];

    // Find all @@id patterns (not preceded by word char)
    const matches = [...transformed.matchAll(/(?<![a-zA-Z0-9])@@([a-zA-Z0-9_-]+)/g)];
    if (matches.length === 0) {
      return { action: "continue" as const };
    }

    const uniqueTokens = Array.from(new Set(matches.map((m) => m[1]))).slice(0, MAX_REFERENCES_PER_PROMPT);
    const currentSessionPath = ctx.sessionManager.getSessionFile();
    const sessions = await listSessions(currentSessionPath);

    for (const token of uniqueTokens) {
      const resolved = resolveThreadToken(token, sessions);

      if (!resolved.session) {
        notes.push(`@@${token}: ${resolved.error || "not found"}`);
        continue;
      }

      const block = buildThreadContextBlock(resolved.session);
      const pattern = new RegExp(`(?<![a-zA-Z0-9])@@${token}\\b`, "g");
      transformed = transformed.replace(pattern, `\n\n${block}\n\n`);
      notes.push(`@@${token} → ${resolved.session.id.slice(0, 8)}`);
    }

    if (matches.length > MAX_REFERENCES_PER_PROMPT) {
      notes.push(`Only first ${MAX_REFERENCES_PER_PROMPT} thread references expanded.`);
    }

    if (notes.length > 0) {
      ctx.ui.notify(notes.join(" | "), "info");
    }

    return { action: "transform" as const, text: transformed };
  });

  // /files:ignore
  pi.registerCommand("files:ignore", {
    description: "Add a file or directory to .pi-ignore",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
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

      if (result.duplicate) {
        ctx.ui.notify(`Already ignored`, "info");
        return;
      }

      const location = path.relative(ctx.cwd, result.ignoreFile) || FILE_PICKER_IGNORE_FILE;
      ctx.ui.notify(`${result.created ? "Created" : "Updated"} ${location}: ${result.entry}`, "info");
    },
  });

  // /files:unignore
  pi.registerCommand("files:unignore", {
    description: "Remove a file or directory from .pi-ignore",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      if (!raw) {
        ctx.ui.notify("Usage: /files:unignore <path>", "warning");
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
        ctx.ui.notify(`No ignore entry found for: ${cleaned}`, "warning");
        return;
      }

      const location = path.relative(ctx.cwd, result.ignoreFile) || FILE_PICKER_IGNORE_FILE;
      ctx.ui.notify(`Removed ${result.entry} from ${location}`, "info");
    },
  });
}