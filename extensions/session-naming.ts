/**
 * Session naming extension — auto-generate session titles.
 *
 * Attempts to generate a concise title from conversation context
 * after sufficient user messages have been exchanged.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const lastAutoTitleAttemptBySession = new Map<string, number>();
const AUTO_TITLE_COOLDOWN_MS = 4 * 60 * 1000; // 4 minutes
const AUTO_TITLE_MIN_USER_MESSAGES = 2;
const AUTO_TITLE_DISABLED = process.env.PI_KIT_NO_AUTO_TITLE === "1";

// --- Helpers ---

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function messageText(msg: AgentMessage): string {
  const content: unknown = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildHandoffSummary(messages: AgentMessage[], maxMessages: number, maxChars: number): string {
  const items = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      const text = messageText(m).replace(/\s+/g, " ").trim();
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .slice(-maxMessages);

  if (items.length === 0) {
    return "No prior user/assistant context available.";
  }

  return clip(items.join("\n"), maxChars);
}

function sanitizeGeneratedTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0] || "";
  const cleaned = firstLine
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter(Boolean).slice(0, 6);
  const compact = words.join(" ").replace(/[.!,;:]+$/g, "").trim();
  if (!compact) return "";
  if (/^untitled$/i.test(compact)) return "";
  return clip(compact, 48);
}

function getExplicitSessionName(ctx: any): string {
  return typeof ctx.sessionManager?.getSessionName === "function"
    ? String(ctx.sessionManager.getSessionName() || "").trim()
    : "";
}

// --- Main ---

export async function maybeAutoNameSession(pi: ExtensionAPI, ctx: any): Promise<void> {
  if (AUTO_TITLE_DISABLED) return;
  if (!ctx.sessionManager?.getSessionId) return;
  if (getExplicitSessionName(ctx)) return;

  const sessionId = ctx.sessionManager.getSessionId();
  const now = Date.now();
  const lastAttempt = lastAutoTitleAttemptBySession.get(sessionId) || 0;
  if (now - lastAttempt < AUTO_TITLE_COOLDOWN_MS) return;

  const context = ctx.sessionManager?.buildSessionContext?.();
  const messages = Array.isArray(context?.messages) ? context.messages as AgentMessage[] : [];
  const userCount = messages.filter((m) => m.role === "user").length;
  if (userCount < AUTO_TITLE_MIN_USER_MESSAGES) return;

  const summary = buildHandoffSummary(messages, 10, 900);
  if (!summary || /No prior user\/assistant context available\./.test(summary)) return;

  lastAutoTitleAttemptBySession.set(sessionId, now);

  const prompt = [
    "Generate a concise conversation title.",
    "Rules:",
    "- Return title only, no quotes, no markdown.",
    "- Max 5 words.",
    "- Focus on concrete task/topic.",
    "- If unclear, return Untitled.",
    "",
    "Conversation summary:",
    summary,
  ].join("\n");

  try {
    const result = await pi.exec("env", ["PI_KIT_NO_AUTO_TITLE=1", "pi", "-p", "--no-session", prompt], {
      timeout: 25_000,
    });
    const title = sanitizeGeneratedTitle(result.stdout || "");
    if (!title) return;
    if (getExplicitSessionName(ctx)) return;

    pi.setSessionName(title);
  } catch {
    // best effort
  }
}

export default function sessionNamingExtension(pi: ExtensionAPI): void {
  pi.on("agent_end", async (_event, ctx) => {
    await maybeAutoNameSession(pi, ctx);
  });
}