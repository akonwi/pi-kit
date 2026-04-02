/**
 * Pager extension — view and annotate long assistant responses.
 *
 * Provides the /pager command for section-by-section review
 * of lengthy assistant messages with note-taking support.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { sharedScreenManager, sharedInteractionDock } from "../ui/shell";
import { openPagerScreen, type LongFormPagerContent, type LongFormSection } from "../ui/screens/pager-screen";
import { createThreadScreen } from "../ui/screens/thread-screen";
import { splitSections } from "./split-sections";

const LONGFORM_MIN_CHARS = 900;
const pagerNotesByEntryId = new Map<string, Map<number, string>>();

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

function splitLongFormSections(text: string): LongFormSection[] {
  return splitSections(text)
    .map((section) => ({
      title: clip(section.title.replace(/\s+/g, " ").trim() || "Section", 64),
      sectionTitle: section.sectionTitle
        ? clip(section.sectionTitle.replace(/\s+/g, " ").trim(), 64)
        : "",
      body: section.body.trim(),
    }))
    .filter((section) => section.body.length > 0);
}

function getPagerNotes(sessionId: string, entryId: string): Map<number, string> {
  const key = `${sessionId}:${entryId}`;
  let notes = pagerNotesByEntryId.get(key);
  if (!notes) {
    notes = new Map<number, string>();
    pagerNotesByEntryId.set(key, notes);
  }
  return notes;
}

function formatPagerFeedbackMessage(pager: LongFormPagerContent, notes: Map<number, string>): string | null {
  const blocks: string[] = [];

  pager.sections.forEach((section, idx) => {
    const note = notes.get(idx)?.trim();
    if (!note) return;
    blocks.push(`## ${section.title}\n${note}`);
  });

  if (blocks.length === 0) return null;

  return [
    "Here is my feedback on your previous response, grouped by section.",
    "",
    ...blocks.flatMap((block, idx) => idx === 0 ? [block] : ["", block]),
    "",
    "Please use this section-specific feedback in your revision or reply.",
  ].join("\n");
}

function buildLongFormPagerFromLastAssistant(ctx: any): LongFormPagerContent | null {
  const branch = Array.isArray(ctx.sessionManager?.getBranch?.()) ? ctx.sessionManager.getBranch() : [];
  const sessionId = typeof ctx.sessionManager?.getSessionId?.() === "string"
    ? ctx.sessionManager.getSessionId()
    : "unknown-session";
  let lastAssistant: AgentMessage | undefined;
  let lastAssistantEntryId: string | null = null;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
    lastAssistant = entry.message as AgentMessage;
    lastAssistantEntryId = typeof entry.id === "string" && entry.id.trim()
      ? entry.id
      : `assistant-${Date.now()}`;
    break;
  }

  if (!lastAssistant || !lastAssistantEntryId) return null;

  const text = messageText(lastAssistant).trim();
  if (!text || text.length < LONGFORM_MIN_CHARS) return null;

  const sections = splitLongFormSections(text);
  return sections.length >= 2 ? { sessionId, entryId: lastAssistantEntryId, sections } : null;
}

// --- Pager management ---

function openLongFormPager(
  pi: ExtensionAPI,
  ctx: any,
  pager: LongFormPagerContent,
  startIndex = 0,
): void {
  const { sections } = pager;
  if (!ctx.hasUI || sections.length < 2) return;

  const dockController = sharedInteractionDock;
  const screenManager = sharedScreenManager;
  const notes = getPagerNotes(pager.sessionId, pager.entryId);

  let screen: ReturnType<typeof openPagerScreen>;
  screen = openPagerScreen({
    ctx,
    pager,
    notes,
    startIndex,
    dock: dockController,
    formatFeedbackMessage: formatPagerFeedbackMessage,
    onSubmitMessage: (message: string) => {
      pagerNotesByEntryId.delete(`${pager.sessionId}:${pager.entryId}`);
      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
      } else {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        ctx.ui.notify("Grouped section feedback queued.", "info");
      }
    },
    onClosed: () => {
      screenManager.clearIfActive(screen);
      screenManager.activate(createThreadScreen(dockController));
    },
  });
  screenManager.activate(screen);
}

function closeLongFormPager(): void {
  sharedScreenManager.closeActive();
  sharedScreenManager.activate(createThreadScreen(sharedInteractionDock));
}

// --- Extension factory ---

export default function pagerExtension(pi: ExtensionAPI): void {
  pi.registerCommand("pager", {
    description: "Open pager for last assistant response, or close if open",
    handler: async (args, ctx) => {
      const action = String(args || "").trim().toLowerCase();
      const activeScreen = sharedScreenManager.getActive();
      const pagerOpen = activeScreen?.id === "pager";

      if (!action && pagerOpen) {
        closeLongFormPager();
        ctx.ui.notify("Pager closed.", "info");
        return;
      }

      if (action === "off" || action === "hide" || action === "close") {
        if (!pagerOpen) {
          ctx.ui.notify("Pager is not open.", "info");
          return;
        }
        closeLongFormPager();
        ctx.ui.notify("Pager closed.", "info");
        return;
      }

      const pager = buildLongFormPagerFromLastAssistant(ctx);
      if (!pager) {
        ctx.ui.notify("No long assistant response found to paginate.", "warning");
        return;
      }

      openLongFormPager(pi, ctx, pager, 0);
    },
  });
}