/**
 * Pager extension — view long assistant responses.
 *
 * Provides the /pager command for viewing lengthy assistant
 * messages. Uses Pi's native editor for display.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { splitSections } from "./split-sections";

const LONGFORM_MIN_CHARS = 900;

// --- Helpers ---

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function messageText(msg: AgentMessage): string {
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

function buildLongFormContentFromLastAssistant(ctx: any): { title: string; content: string } | null {
  const branch = Array.isArray(ctx.sessionManager?.getBranch?.()) ? ctx.sessionManager.getBranch() : [];

  let lastAssistant: AgentMessage | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
    lastAssistant = entry.message as AgentMessage;
    break;
  }

  if (!lastAssistant) return null;

  const text = messageText(lastAssistant).trim();
  if (!text || text.length < LONGFORM_MIN_CHARS) return null;

  const sections = splitSections(text);
  if (sections.length < 2) return null;

  // Format sections with headers
  const lines: string[] = [];
  for (const section of sections) {
    const title = section.sectionTitle
      ? `${section.sectionTitle}: ${section.title}`
      : section.title;
    lines.push(`\n${"─".repeat(60)}`);
    lines.push(`## ${title}`);
    lines.push("─".repeat(60));
    lines.push(section.body.trim());
  }

  return {
    title: clip(sections[0].title, 50),
    content: lines.join("\n"),
  };
}

// --- Extension factory ---

export default function pagerExtension(pi: ExtensionAPI): void {
  pi.registerCommand("pager", {
    description: "Open pager for last assistant response",
    handler: async (_args, ctx) => {
      const result = buildLongFormContentFromLastAssistant(ctx);
      if (!result) {
        ctx.ui.notify("No long assistant response found to paginate.", "warning");
        return;
      }

      // Use Pi's native multi-line editor to show the content
      await ctx.ui.editor(`Pager: ${result.title}`, result.content);
    },
  });
}