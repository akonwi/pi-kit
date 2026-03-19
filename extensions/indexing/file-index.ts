/**
 * Lazy file index ported from `v2/src/features/files/file-index.ts`.
 *
 * The extension composer needs synchronous suggestions while typing,
 * so this version exposes both async `suggest()` and cached `suggestSync()`.
 */

import path from "node:path";
import { scanFiles, type ScanResult } from "./scan-files";
import { scoreMatch } from "./score";

export type FileIndexEntry = {
  path: string;
  isDir: boolean;
};

export type FileSuggestion = {
  name: string;
  description: string;
  value: string;
  isDir: boolean;
};

function toSuggestions(entries: FileIndexEntry[], query: string): FileSuggestion[] {
  const norm = query.replace(/^@/, "").trim();

  return entries
    .map((entry) => {
      const baseName = path.posix.basename(entry.path.replace(/\/$/, ""));
      const pathScore = scoreMatch(entry.path, norm);
      const baseScore = norm ? scoreMatch(baseName, norm) : 0;
      const score = baseScore > 0
        ? Math.max(pathScore, baseScore + 8)
        : pathScore;

      return {
        entry,
        baseName,
        score,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (!norm) return a.entry.path.localeCompare(b.entry.path);
      return b.score - a.score
        || Number(b.entry.isDir) - Number(a.entry.isDir)
        || a.baseName.localeCompare(b.baseName)
        || a.entry.path.localeCompare(b.entry.path);
    })
    .map((x) => ({
      name: `@${x.entry.path}`,
      description: x.entry.isDir ? "directory" : "",
      value: x.entry.path,
      isDir: x.entry.isDir,
    }));
}

export function createFileIndex(cwd: string) {
  let cached: FileIndexEntry[] | null = null;
  let scanning: Promise<FileIndexEntry[]> | null = null;

  async function doScan(): Promise<FileIndexEntry[]> {
    const result: ScanResult = await scanFiles(cwd);
    return [
      ...result.dirs.map((p) => ({ path: p, isDir: true })),
      ...result.files.map((p) => ({ path: p, isDir: false })),
    ];
  }

  async function ensureLoaded(): Promise<FileIndexEntry[]> {
    if (cached) return cached;
    if (!scanning) {
      scanning = doScan().then((entries) => {
        cached = entries;
        scanning = null;
        return entries;
      });
    }
    return scanning;
  }

  async function suggest(query: string): Promise<FileSuggestion[]> {
    const entries = await ensureLoaded();
    return toSuggestions(entries, query);
  }

  function suggestSync(query: string): FileSuggestion[] {
    if (!cached) return [];
    return toSuggestions(cached, query);
  }

  function invalidate(): void {
    cached = null;
    scanning = null;
  }

  function isLoaded(): boolean {
    return cached !== null;
  }

  return { suggest, suggestSync, invalidate, isLoaded, ensureLoaded };
}

export type FileIndex = ReturnType<typeof createFileIndex>;
