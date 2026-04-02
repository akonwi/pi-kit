/**
 * Session commands extension — thread/session management.
 *
 * Provides /threads, /switch, and /threads:manage commands
 * for navigation and management of Pi sessions.
 */

import { rm } from "node:fs/promises";
import { SessionManager, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { sharedScreenManager, sharedInteractionDock } from "./ui/shell";
import { openFilterPickerScreen } from "./ui/screens/filter-picker-screen";
import { openTextInputScreen } from "./ui/screens/text-input-screen";
import { createThreadScreen } from "./ui/screens/thread-screen";
import { formatSessionOptionLite, listSessions, showTransientBadge, threadTitle, type SessionInfoLite } from "./thread-references";
import { refreshThreadReferenceIndexes } from "./ui/thread-reference-shell";

// --- Helpers ---

async function openSessionPicker(
  ctx: any,
  options: {
    title: string;
    initialQuery?: string;
    includeCurrent?: boolean;
  },
): Promise<SessionInfoLite | undefined> {
  const currentSessionPath = ctx.sessionManager.getSessionFile();
  const sessions = await listSessions(currentSessionPath, options.includeCurrent ?? false);
  if (sessions.length === 0) {
    ctx.ui.notify("No matching threads found", "warning");
    return undefined;
  }

  const dockController = sharedInteractionDock;
  const screenManager = sharedScreenManager;

  let screen: ReturnType<typeof openFilterPickerScreen<SessionInfoLite>>["screen"];
  const opened = openFilterPickerScreen<SessionInfoLite>({
    ctx,
    dock: dockController,
    title: options.title,
    items: sessions.map((session) => {
      const option = formatSessionOptionLite(session);
      return {
        label: option.label,
        description: option.description,
        value: session,
        searchText: `${session.id} ${session.cwd} ${session.name || ""} ${session.firstMessage || ""}`,
      };
    }),
    initialQuery: options.initialQuery || "",
    visibleItems: 8,
    onClosed: () => {
      screenManager.clearIfActive(screen);
      screenManager.activate(createThreadScreen(dockController));
    },
  });
  screen = opened.screen;
  screenManager.activate(screen);
  return opened.result;
}

async function openManageThreadActionPicker(
  ctx: any,
  session: SessionInfoLite,
  isCurrent: boolean,
): Promise<"Rename" | "Delete" | undefined> {
  const dockController = sharedInteractionDock;
  const screenManager = sharedScreenManager;

  let screen: ReturnType<typeof openFilterPickerScreen<"Rename" | "Delete">>["screen"];
  const opened = openFilterPickerScreen<"Rename" | "Delete">({
    ctx,
    dock: dockController,
    title: `Manage ${threadTitle(session)}`,
    items: [
      {
        label: "Rename",
        description: isCurrent ? "rename current thread" : "rename selected thread",
        value: "Rename",
        searchText: "rename",
      },
      {
        label: "Delete",
        description: isCurrent ? "cannot delete current thread" : "delete selected thread",
        value: "Delete",
        searchText: "delete remove",
      },
    ],
    visibleItems: 2,
    onClosed: () => {
      screenManager.clearIfActive(screen);
      screenManager.activate(createThreadScreen(dockController));
    },
  });
  screen = opened.screen;
  screenManager.activate(screen);
  return opened.result;
}

async function openThreadRenameInput(
  ctx: any,
  session: SessionInfoLite,
): Promise<string | undefined> {
  const dockController = sharedInteractionDock;
  const screenManager = sharedScreenManager;

  let screen: ReturnType<typeof openTextInputScreen>["screen"];
  const opened = openTextInputScreen({
    ctx,
    dock: dockController,
    title: `Rename ${threadTitle(session)}`,
    initialValue: session.name?.trim() || threadTitle(session),
    placeholder: "New thread name",
    onClosed: () => {
      screenManager.clearIfActive(screen);
      screenManager.activate(createThreadScreen(dockController));
    },
  });
  screen = opened.screen;
  screenManager.activate(screen);
  return opened.result;
}

// --- Extension factory ---

export default function sessionCommandsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("threads", {
    description: "List other sessions and insert a [[thread:<id>]] reference",
    handler: async (args, ctx) => {
      const chosen = await openSessionPicker(ctx, {
        title: "Insert thread reference",
        initialQuery: String(args || "").trim(),
      });
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
      const chosen = await openSessionPicker(ctx, {
        title: "Switch to thread",
        initialQuery: String(args || "").trim(),
      });
      if (!chosen) return;

      const result = await ctx.switchSession(chosen.path);
      if (result.cancelled) return;

      showTransientBadge("THREAD SWITCHED");
      ctx.ui.notify(`Switched to ${threadTitle(chosen)} (${chosen.id.slice(0, 8)})`, "info");
    },
  });

  pi.registerCommand("threads:manage", {
    description: "Rename or delete a thread",
    handler: async (args, ctx) => {
      const chosen = await openSessionPicker(ctx, {
        title: "Manage thread",
        initialQuery: String(args || "").trim(),
        includeCurrent: true,
      });
      if (!chosen) return;

      const currentSessionPath = ctx.sessionManager.getSessionFile();
      const isCurrent = Boolean(currentSessionPath && chosen.path === currentSessionPath);
      const action = await openManageThreadActionPicker(ctx, chosen, isCurrent);
      if (!action) return;

      if (action === "Rename") {
        const value = await openThreadRenameInput(ctx, chosen);
        const name = (value || "").trim();
        if (!name) return;

        if (isCurrent) {
          pi.setSessionName(name);
        } else {
          const sm = SessionManager.open(chosen.path);
          sm.appendSessionInfo(name);
        }

        await refreshThreadReferenceIndexes({ threads: true });
        showTransientBadge("THREAD RENAMED");
        ctx.ui.notify(`Renamed thread to "${name}"`, "info");
        return;
      }

      if (isCurrent) {
        ctx.ui.notify("Cannot delete the currently active thread", "warning");
        return;
      }

      const ok = await ctx.ui.confirm(
        "Delete thread?",
        `Permanently delete "${threadTitle(chosen)}" (${chosen.id.slice(0, 8)})?`,
      );
      if (!ok) return;

      await rm(chosen.path);
      await refreshThreadReferenceIndexes({ threads: true });
      showTransientBadge("THREAD DELETED");
      ctx.ui.notify("Thread deleted", "info");
    },
  });
}