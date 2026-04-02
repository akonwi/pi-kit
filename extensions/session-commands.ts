/**
 * Session commands extension — thread/session management.
 *
 * Provides /threads, /switch, and /threads:manage commands
 * for navigation and management of Pi sessions.
 * Uses Pi's native UI primitives for dialogs.
 */

import { rm } from "node:fs/promises";
import { SessionManager, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listSessions, threadTitle, type SessionInfoLite } from "./thread-references";

// --- Helpers ---

type SessionItem = SessionInfoLite & { isCurrent?: boolean };

function formatSessionOption(s: SessionItem): { label: string; description: string } {
  const label = s.name?.trim() || s.firstMessage?.slice(0, 40) || "Untitled";
  const desc = `${s.cwd} • ${s.id.slice(0, 8)}`;
  return { label, description: desc };
}

function formatSessionList(sessions: SessionItem[]): string[] {
  return sessions.map((s) => {
    const { label, description } = formatSessionOption(s);
    return `${label} (${description})`;
  });
}

async function pickSession(
  ctx: any,
  title: string,
  sessions: SessionItem[],
): Promise<SessionItem | undefined> {
  if (sessions.length === 0) {
    ctx.ui.notify("No sessions found", "warning");
    return undefined;
  }

  const options = formatSessionList(sessions);
  const choice = await ctx.ui.select(title, options);
  if (choice === undefined) return undefined;

  const idx = options.indexOf(choice);
  return sessions[idx];
}

// --- Extension factory ---

export default function sessionCommandsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("threads", {
    description: "Browse threads and insert a thread reference (@@id)",
    handler: async (args, ctx) => {
      const query = String(args || "").trim();
      const currentPath = ctx.sessionManager.getSessionFile();
      const sessions = await listSessions(currentPath, false);

      // Filter by query if provided
      const filtered = query
        ? sessions.filter((s) =>
            s.id.toLowerCase().includes(query.toLowerCase()) ||
            (s.name || "").toLowerCase().includes(query.toLowerCase()) ||
            s.cwd.toLowerCase().includes(query.toLowerCase()),
          )
        : sessions;

      const chosen = await pickSession(ctx, "Insert thread reference", filtered);
      if (!chosen) return;

      const token = `@@${chosen.id.slice(0, 8)}`;
      ctx.ui.pasteToEditor(`${token} `);
      ctx.ui.notify(`Inserted ${token}`, "info");
    },
  });

  pi.registerCommand("switch", {
    description: "Switch to another thread/session",
    handler: async (args, ctx) => {
      const query = String(args || "").trim();
      const currentPath = ctx.sessionManager.getSessionFile();
      const sessions = await listSessions(currentPath, false);

      const filtered = query
        ? sessions.filter((s) =>
            s.id.toLowerCase().includes(query.toLowerCase()) ||
            (s.name || "").toLowerCase().includes(query.toLowerCase()) ||
            s.cwd.toLowerCase().includes(query.toLowerCase()),
          )
        : sessions;

      const chosen = await pickSession(ctx, "Switch to thread", filtered);
      if (!chosen) return;

      const result = await ctx.switchSession(chosen.path);
      if (result.cancelled) return;

      ctx.ui.notify(`Switched to ${threadTitle(chosen)} (${chosen.id.slice(0, 8)})`, "info");
    },
  });

  pi.registerCommand("threads:manage", {
    description: "Rename or delete a thread",
    handler: async (args, ctx) => {
      const query = String(args || "").trim();
      const currentPath = ctx.sessionManager.getSessionFile();
      const sessions = await listSessions(currentPath, true);
      const sessionsWithFlag = sessions.map((s) => ({
        ...s,
        isCurrent: s.path === currentPath,
      }));

      const filtered = query
        ? sessionsWithFlag.filter((s) =>
            s.id.toLowerCase().includes(query.toLowerCase()) ||
            (s.name || "").toLowerCase().includes(query.toLowerCase()),
          )
        : sessionsWithFlag;

      const chosen = await pickSession(ctx, "Manage thread", filtered);
      if (!chosen) return;

      const action = await ctx.ui.select(`Manage ${threadTitle(chosen)}`, [
        "Rename",
        "Delete",
      ]);

      if (action === "Rename") {
        const name = await ctx.ui.input("New thread name", chosen.name?.trim() || "");
        if (!name?.trim()) return;

        if (chosen.isCurrent) {
          pi.setSessionName(name.trim());
        } else {
          const sm = SessionManager.open(chosen.path);
          sm.appendSessionInfo(name.trim());
        }

        ctx.ui.notify(`Renamed thread to "${name.trim()}"`, "info");
        return;
      }

      if (action === "Delete") {
        if (chosen.isCurrent) {
          ctx.ui.notify("Cannot delete the currently active thread", "warning");
          return;
        }

        const ok = await ctx.ui.confirm(
          "Delete thread?",
          `Permanently delete "${threadTitle(chosen)}" (${chosen.id.slice(0, 8)})?`,
        );
        if (!ok) return;

        await rm(chosen.path);
        ctx.ui.notify("Thread deleted", "info");
      }
    },
  });
}