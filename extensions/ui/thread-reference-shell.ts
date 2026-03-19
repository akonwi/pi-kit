import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createFileIndex, type FileIndex } from "../indexing/file-index";
import { createThreadIndex, type ThreadIndex } from "../indexing/thread-index";
import { scoreMatch } from "../indexing/score";
import { TextComposerSurface, type TextComposerPickerItem } from "./input-surfaces/text-composer";
import { sharedInteractionDock, type DockState } from "./shell";
import {
  FALLBACK_BUILT_IN_COMMANDS,
  PICKER_MAX_ITEMS,
  discoverBuiltInCommands,
  getTransientBadge,
  messageText,
  scanLegacyIgnoreFiles,
  requestThreadReferenceRender,
  setThreadReferenceRenderRequest,
  showTransientBadge,
} from "../thread-references";

const BUILT_IN_COMMAND_DESCRIPTIONS: Record<string, string> = {
  login: "Authenticate with a provider",
  logout: "Clear provider authentication",
  model: "Select a model",
  "scoped-models": "Show models available for the current provider/session",
  settings: "Open or inspect settings",
  resume: "Resume a recent session",
  new: "Start a new session",
  name: "Rename the current session",
  session: "Show current session details",
  tree: "Show the session tree",
  fork: "Fork the current session/thread",
  compact: "Compact the current conversation",
  copy: "Copy the latest response",
  export: "Export the current session",
  share: "Share the current session",
  reload: "Reload extensions, prompts, and themes",
  hotkeys: "Show keyboard shortcuts",
  changelog: "Show recent Pi changes",
  quit: "Quit Pi",
  exit: "Quit Pi",
};

let fileIndex: FileIndex | undefined;
let threadIndex: ThreadIndex | undefined;
let currentCtx: any;
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

  for (const [name, description] of Object.entries(BUILT_IN_COMMAND_DESCRIPTIONS)) {
    if (!commandDescriptions.has(name)) {
      commandDescriptions.set(name, description);
    }
  }

  const orderedNames = Array.from(new Set([...builtInCommands, ...extensionCommandNames]));
  const normalizedQuery = query.trim();

  return orderedNames
    .map((name, index) => {
      const value = `/${name}`;
      const description = commandDescriptions.get(name) || "";
      const score = normalizedQuery
        ? Math.max(scoreMatch(name, normalizedQuery), scoreMatch(description, normalizedQuery))
        : 1;

      return {
        label: value,
        value,
        description,
        score,
        index,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (!normalizedQuery) return a.index - b.index;
      return b.score - a.score || a.index - b.index || a.value.localeCompare(b.value);
    })
    .map(({ label, value, description }) => ({ label, value, description }));
}

function getFileSuggestions(query: string): TextComposerPickerItem[] {
  return (fileIndex?.suggestSync(query) || []).map((item) => ({
    label: item.name,
    value: item.name,
    description: item.description,
    appendSpace: !item.isDir,
  }));
}

function getThreadSuggestions(query: string): TextComposerPickerItem[] {
  return (threadIndex?.suggestSync(query) || []).map((item) => ({
    label: item.name,
    value: item.value,
    description: item.description,
  }));
}

function getBashSuggestions(query: string): TextComposerPickerItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  return bashHistory
    .map((cmd, index) => ({
      label: `!${cmd}`,
      value: cmd,
      description: "recent bash",
      score: normalizedQuery ? scoreMatch(cmd.toLowerCase(), normalizedQuery) : 1,
      index,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (!normalizedQuery) return a.index - b.index;
      return b.score - a.score || a.index - b.index || a.value.localeCompare(b.value);
    })
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

async function refreshIndexes(
  ctx: any,
  options?: { files?: boolean; threads?: boolean },
): Promise<void> {
  if (!fileIndex || (options?.files ?? true)) {
    fileIndex = createFileIndex(ctx.cwd);
  }
  if (options?.files ?? true) {
    fileIndex.invalidate();
    await fileIndex.ensureLoaded();
  }

  if (!threadIndex) {
    threadIndex = createThreadIndex(ctx.sessionManager.getSessionFile());
  }
  if (options?.threads ?? true) {
    threadIndex.invalidate(ctx.sessionManager.getSessionFile());
    await threadIndex.ensureLoaded();
  }

  requestThreadReferenceRender();
}

export async function refreshThreadReferenceIndexes(
  options?: { files?: boolean; threads?: boolean },
): Promise<void> {
  if (!currentCtx) return;
  await refreshIndexes(currentCtx, options);
}

async function installThreadComposer(pi: ExtensionAPI, ctx: any): Promise<void> {
  currentCtx = ctx;
  builtInCommands = await discoverBuiltInCommands();
  await refreshIndexes(ctx, { files: true, threads: true });
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
