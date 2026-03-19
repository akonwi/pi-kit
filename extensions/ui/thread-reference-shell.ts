import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { TextComposerSurface, type TextComposerPickerItem } from "./input-surfaces/text-composer";
import { sharedInteractionDock, type DockState } from "./shell";
import {
  FALLBACK_BUILT_IN_COMMANDS,
  PICKER_MAX_ITEMS,
  discoverBuiltInCommands,
  getTransientBadge,
  listSessions,
  messageText,
  scanFiles,
  scanLegacyIgnoreFiles,
  requestThreadReferenceRender,
  scoreMatch,
  setThreadReferenceRenderRequest,
  showTransientBadge,
  threadTitle,
  type SessionInfoLite,
} from "../thread-references";

let fileIndex: string[] = [];
let threadIndex: SessionInfoLite[] = [];
let bashHistory: string[] = [];
let builtInCommands: string[] = [...FALLBACK_BUILT_IN_COMMANDS];
let installedEditorSessionId: string | undefined;
let activeEditor: TextComposerSurface | undefined;
let pickerOpen = false;
let activeDockState: DockState = {
  surface: "text-composer",
  mode: "thread",
  supportsPicker: true,
};
let lastLegacyIgnoreWarningKey: string | undefined;

function normalizeBashCommand(raw: string): string {
  const text = (raw || "").trim();
  if (!text) return "";
  const withoutBang = text.startsWith("!") ? text.slice(1).trim() : text;
  return withoutBang.replace(/\s+/g, " ").trim();
}

function refreshBashHistory(ctx: any): void {
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

  bashHistory = next.reverse();
}

function pushBashHistory(command: string): void {
  const parsed = normalizeBashCommand(command);
  if (!parsed) return;
  bashHistory = [parsed, ...bashHistory.filter((c) => c !== parsed)].slice(0, 200);
}

function getSlashSuggestions(pi: ExtensionAPI, query: string): TextComposerPickerItem[] {
  const extensionCommands = pi.getCommands();
  const extensionCommandNames = extensionCommands.map((c) => c.name);
  const commandDescriptions = new Map<string, string>();

  for (const command of extensionCommands) {
    if (typeof command.name !== "string" || !command.name.trim()) continue;
    const description = typeof (command as { description?: unknown }).description === "string"
      ? String((command as { description?: unknown }).description)
      : "";
    commandDescriptions.set(command.name, description);
  }

  return Array.from(new Set([...builtInCommands, ...extensionCommandNames]))
    .map((name) => {
      const value = `/${name}`;
      return {
        label: value,
        value,
        description: commandDescriptions.get(name) || "",
        score: scoreMatch(name, query),
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
    .map(({ label, value, description }) => ({ label, value, description }));
}

function getFileSuggestions(query: string): TextComposerPickerItem[] {
  const norm = query.replace(/^@/, "").toLowerCase();
  return fileIndex
    .map((p) => ({
      label: `@${p}`,
      value: `@${p}`,
      description: p.endsWith("/") ? "directory" : "",
      score: scoreMatch(p.toLowerCase(), norm),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
    .map(({ label, value, description }) => ({ label, value, description }));
}

function getThreadSuggestions(query: string): TextComposerPickerItem[] {
  const q = query.trim().toLowerCase();
  return threadIndex
    .map((s) => {
      const title = threadTitle(s);
      const id8 = s.id.slice(0, 8);
      const cwdLabel = path.basename(s.cwd) || s.cwd;
      const haystack = `${title} ${id8} ${s.cwd}`.toLowerCase();
      const score = q ? scoreMatch(haystack, q) : 1;
      return { title, id8, cwdLabel, modified: s.modified, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.modified.getTime() - a.modified.getTime())
    .map((x) => ({
      label: x.title,
      value: x.id8,
      description: `${x.id8}  ·  ${x.cwdLabel}`,
    }));
}

function getBashSuggestions(query: string): TextComposerPickerItem[] {
  const q = query.trim().toLowerCase();
  return bashHistory
    .map((cmd) => ({
      label: `!${cmd}`,
      value: cmd,
      description: "recent bash",
      score: scoreMatch(cmd.toLowerCase(), q),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ label, value, description }) => ({ label, value, description }));
}

async function warnAboutLegacyIgnoreFiles(ctx: any): Promise<void> {
  const legacyFiles = await scanLegacyIgnoreFiles(ctx.cwd);
  if (legacyFiles.length === 0) {
    lastLegacyIgnoreWarningKey = undefined;
    return;
  }

  const warningKey = legacyFiles.join("\n");
  if (warningKey === lastLegacyIgnoreWarningKey) {
    return;
  }
  lastLegacyIgnoreWarningKey = warningKey;

  const listed = legacyFiles
    .slice(0, 3)
    .map((file) => path.relative(ctx.cwd, file) || ".pi-files-ignore")
    .join(", ");
  const extra = legacyFiles.length > 3 ? ` (+${legacyFiles.length - 3} more)` : "";
  ctx.ui.notify(
    `Deprecated .pi-files-ignore detected (${listed}${extra}). It is ignored; rename it to .pi-ignore.`,
    "warning",
  );
}

async function installThreadComposer(pi: ExtensionAPI, ctx: any): Promise<void> {
  builtInCommands = await discoverBuiltInCommands();
  fileIndex = await scanFiles(ctx.cwd);
  threadIndex = await listSessions(ctx.sessionManager.getSessionFile());
  refreshBashHistory(ctx);
  pickerOpen = false;
  await warnAboutLegacyIgnoreFiles(ctx);

  sharedInteractionDock.setInputHandler((data: string) => {
    const shouldCapture = Boolean(pickerOpen && activeEditor?.shouldCapturePickerKey(data));
    if (!shouldCapture || !activeEditor) return undefined;
    activeEditor.handleInput(data);
    return { consume: true };
  });
  sharedInteractionDock.setScreenInputBlocker(() => pickerOpen);

  ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
    const editor = new TextComposerSurface(
      tui,
      theme,
      keybindings,
      {
        getSlashSuggestions: (query) => getSlashSuggestions(pi, query),
        getFileSuggestions,
        getThreadSuggestions,
        getBashSuggestions,
      },
      {
        pickerMaxItems: PICKER_MAX_ITEMS,
        getTransientBadge,
        onThreadInserted: () => showTransientBadge("THREAD INSERTED"),
        onPickerVisibilityChange: (open: boolean) => {
          pickerOpen = open;
        },
        onLayoutChange: (metrics) => {
          sharedInteractionDock.setMetrics(metrics);
        },
      },
    );
    editor.setDockState(activeDockState);
    activeEditor = editor;
    setThreadReferenceRenderRequest(() => editor.requestRender());
    return editor;
  });
}

export async function ensureThreadReferenceEditorInstalled(pi: ExtensionAPI, ctx: any): Promise<void> {
  if (!ctx.hasUI) return;
  const sid = ctx.sessionManager?.getSessionId?.();
  if (sid && installedEditorSessionId === sid) return;
  await installThreadComposer(pi, ctx);
  installedEditorSessionId = sid;
}

export function refreshThreadReferenceComposer(): void {
  requestThreadReferenceRender();
}

export function setThreadReferenceDockState(state: DockState): void {
  activeDockState = state;
  activeEditor?.setDockState(state);
  requestThreadReferenceRender();
}

export function setActiveEditorRenderDelegate(delegate: { render(width: number): string[] } | undefined): void {
  activeEditor?.setRenderDelegate(delegate);
}

export function handleThreadReferenceUserBash(event: { command?: string }, ctx: any): void {
  if (typeof event.command === "string" && event.command.trim()) {
    pushBashHistory(event.command);
    requestThreadReferenceRender();
  } else {
    refreshBashHistory(ctx);
    requestThreadReferenceRender();
  }
}

export function handleThreadReferenceHandoff(data?: { stay?: boolean }): void {
  showTransientBadge(data?.stay ? "HANDOFF CREATED" : "HANDOFF SWITCHED");
}
