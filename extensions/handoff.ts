/**
 * Handoff extension — create child thread with compact context.
 *
 * Provides the /handoff command for spawning a new session with
 * summarized context from the parent.
 */

import { rm } from "node:fs/promises";
import { SessionManager, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { readConfig } from "./notifications";
import { showTransientBadge } from "./thread-references";
import { messageText } from "./session-naming";

// --- Helpers ---

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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

function parseHandoffArgs(args: string | undefined): { stay: boolean; prompt: string } {
  const raw = (args || "").trim();
  if (!raw) return { stay: false, prompt: "Continue from this handoff context." };

  const parts = raw.split(/\s+/);
  let stay = false;
  if (parts[0] === "--stay") {
    stay = true;
    parts.shift();
  }

  const prompt = parts.join(" ").trim() || "Continue from this handoff context.";
  return { stay, prompt };
}

// --- Extension factory ---

export default function handoffExtension(pi: ExtensionAPI): void {
  pi.registerCommand("handoff", {
    description: "Create a child thread with compact context. Use --stay to avoid switching.",
    handler: async (args, ctx) => {
      const { stay, prompt } = parseHandoffArgs(args);
      const sourceSessionPath = ctx.sessionManager.getSessionFile();
      const sourceSessionId = ctx.sessionManager.getSessionId();
      const sourceIdShort = sourceSessionId.slice(0, 8);

      if (!sourceSessionPath) {
        ctx.ui.notify("Handoff requires a persisted session.", "warning");
        return;
      }

      const config = await readConfig();
      const handoffConfig = (config as any).handoff ?? { maxMessages: 20, maxSummaryChars: 1400 };
      const context = ctx.sessionManager.buildSessionContext();
      const summary = buildHandoffSummary(
        context.messages,
        handoffConfig.maxMessages,
        handoffConfig.maxSummaryChars,
      );

      const childName = `↳ ${clip(prompt, 48)}`;
      const seededPrompt = [
        prompt,
        "",
        "---",
        "",
        "Handoff context from parent thread:",
        summary,
        "",
        `Parent thread reference: [[thread:${sourceIdShort}]]`,
        `Parent session ID: ${sourceSessionId}`,
      ].join("\n");

      if (stay) {
        const childManager = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir());
        childManager.newSession({ parentSession: sourceSessionPath });
        childManager.appendSessionInfo(childName);
        childManager.appendMessage({
          role: "user",
          content: [{ type: "text", text: seededPrompt }],
          timestamp: Date.now(),
        });

        const childId = childManager.getSessionId().slice(0, 8);
        pi.events.emit("thread:handoff", { stay: true, childId });
        ctx.ui.notify(`Created child thread ${childId} (stayed in current thread).`, "info");
        return;
      }

      const result = await ctx.newSession({
        parentSession: sourceSessionPath,
        setup: async (sm) => {
          sm.appendSessionInfo(childName);
        },
      });

      if (result.cancelled) return;

      pi.events.emit("thread:handoff", { stay: false });
      pi.sendUserMessage(seededPrompt);
    },
  });
}