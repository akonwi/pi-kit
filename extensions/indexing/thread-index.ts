/**
 * Lazy thread/session index patterned after `v2/src/features/threads/thread-index.ts`.
 *
 * The extension composer needs synchronous suggestions while typing,
 * so this version exposes both async `suggest()` and cached `suggestSync()`.
 */

import { SessionManager, type SessionInfo } from "@mariozechner/pi-coding-agent";
import { scoreMatch } from "./score";

export type ThreadSuggestion = {
  name: string;
  description: string;
  value: string;
};

function threadTitle(s: SessionInfo): string {
  const head = (s.name?.trim() || s.firstMessage?.trim() || "Untitled thread").replace(/\s+/g, " ");
  return head.length <= 80 ? head : `${head.slice(0, 79)}…`;
}

function formatSuggestions(sessions: SessionInfo[], query: string): ThreadSuggestion[] {
  const q = query.trim();

  return sessions
    .map((s) => {
      const title = threadTitle(s);
      const id8 = s.id.slice(0, 8);
      const haystack = `${title} ${id8} ${s.cwd}`;
      const score = q ? scoreMatch(haystack, q) : 1;
      return { s, title, id8, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.s.modified.getTime() - a.s.modified.getTime())
    .map((x) => ({
      name: x.title,
      description: `${x.id8}  ·  ${x.s.cwd.split("/").pop() || x.s.cwd}`,
      value: x.id8,
    }));
}

export function createThreadIndex(currentSessionPath?: string) {
  let cached: SessionInfo[] | null = null;
  let fetching: Promise<SessionInfo[]> | null = null;

  async function doFetch(): Promise<SessionInfo[]> {
    const all = await SessionManager.listAll();
    return all
      .filter((s) => !currentSessionPath || s.path !== currentSessionPath)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  async function ensureLoaded(): Promise<SessionInfo[]> {
    if (cached) return cached;
    if (!fetching) {
      fetching = doFetch().then((sessions) => {
        cached = sessions;
        fetching = null;
        return sessions;
      });
    }
    return fetching;
  }

  async function suggest(query: string): Promise<ThreadSuggestion[]> {
    const sessions = await ensureLoaded();
    return formatSuggestions(sessions, query);
  }

  function suggestSync(query: string): ThreadSuggestion[] {
    if (!cached) return [];
    return formatSuggestions(cached, query);
  }

  function invalidate(nextCurrentSessionPath?: string): void {
    currentSessionPath = nextCurrentSessionPath;
    cached = null;
    fetching = null;
  }

  return { suggest, suggestSync, invalidate, ensureLoaded };
}

export type ThreadIndex = ReturnType<typeof createThreadIndex>;
