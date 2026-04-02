/**
 * Thread references extension — `@@id` syntax for thread context.
 *
 * Provides `@@id` expansion to thread context in user input.
 */

import { readdir, readFile, stat } from "node:fs/promises";
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

}
