/**
 * Ignore extension — manage .pi-ignore for file picker exclusions.
 *
 * Provides /files:ignore and /files:unignore commands.
 */

import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const FILE_PICKER_IGNORE_FILE = ".pi-ignore";

// --- Helpers ---

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

function isWithinDir(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function findNearestIgnoreFile(baseDir: string, targetPath: string): Promise<string> {
  let current = targetPath;
  while (isWithinDir(current, baseDir)) {
    const candidate = path.join(current, FILE_PICKER_IGNORE_FILE);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // continue upward
    }
    if (current === baseDir) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(baseDir, FILE_PICKER_IGNORE_FILE);
}

function normalizeIgnoreEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return "";
  const directoryOnly = trimmed.endsWith("/");
  const normalized = normalizeRelativePath(directoryOnly ? trimmed.slice(0, -1) : trimmed);
  return directoryOnly ? `${normalized}/` : normalized;
}

async function appendIgnoreEntry(
  baseDir: string,
  targetPath: string,
  isDirectory: boolean,
): Promise<{ ignoreFile: string; entry: string; created: boolean; duplicate: boolean }> {
  const anchorDir = isDirectory ? targetPath : path.dirname(targetPath);
  const ignoreFile = await findNearestIgnoreFile(baseDir, anchorDir);
  const ignoreDir = path.dirname(ignoreFile);
  const relative = normalizeRelativePath(path.relative(ignoreDir, targetPath));
  const entry = isDirectory ? `${relative}/` : relative;

  let existing = "";
  let created = false;
  try {
    existing = await readFile(ignoreFile, "utf8");
  } catch {
    created = true;
  }

  const existingEntries = new Set(
    existing.split(/\r?\n/g).map(normalizeIgnoreEntry).filter(Boolean),
  );

  if (existingEntries.has(entry)) {
    return { ignoreFile, entry, created: false, duplicate: true };
  }

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  await appendFile(ignoreFile, `${needsLeadingNewline ? "\n" : ""}${entry}\n`, "utf8");
  return { ignoreFile, entry, created, duplicate: false };
}

async function listIgnoreEntriesInFile(ignoreFile: string): Promise<{ ignoreFile: string; entry: string }[]> {
  try {
    const content = await readFile(ignoreFile, "utf8");
    return content
      .split(/\r?\n/g)
      .map(normalizeIgnoreEntry)
      .filter(Boolean)
      .map((entry) => ({ ignoreFile, entry }));
  } catch {
    return [];
  }
}

async function removeIgnoreEntryFromFile(ignoreFile: string, entry: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(ignoreFile, "utf8");
  } catch {
    return false;
  }
  const lines = content.split(/\r?\n/g);
  const kept = lines.filter((line) => normalizeIgnoreEntry(line) !== entry);
  if (kept.length === lines.length) return false;
  await writeFile(ignoreFile, `${kept.join("\n").replace(/\n+$/g, "")}\n`, "utf8");
  return true;
}

async function removeIgnoreEntryByPath(
  baseDir: string,
  targetPath: string,
): Promise<{ ignoreFile?: string; entry?: string; removed: boolean }> {
  const searchDirs: string[] = [];
  let current = targetPath;
  while (isWithinDir(current, baseDir)) {
    searchDirs.push(current);
    if (current === baseDir) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const candidates = Array.from(new Set([
    normalizeRelativePath(path.relative(baseDir, targetPath)),
    `${normalizeRelativePath(path.relative(baseDir, targetPath))}/`,
  ].filter(Boolean)));

  for (const dir of searchDirs) {
    const ignoreFile = path.join(dir, FILE_PICKER_IGNORE_FILE);
    const entries = await listIgnoreEntriesInFile(ignoreFile);
    for (const candidate of candidates) {
      if (entries.some((item) => item.entry === candidate)) {
        const removed = await removeIgnoreEntryFromFile(ignoreFile, candidate);
        if (removed) return { ignoreFile, entry: candidate, removed: true };
      }
    }
  }

  return { removed: false };
}

// --- Extension factory ---

export default function ignoreExtension(pi: ExtensionAPI): void {
  pi.registerCommand("files:ignore", {
    description: "Add a file or directory to .pi-ignore",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      if (!raw) {
        ctx.ui.notify("Usage: /files:ignore <path>", "warning");
        return;
      }

      const cleaned = raw.replace(/^@/, "").trim().replace(/\/$/, "");
      const absolute = path.resolve(ctx.cwd, cleaned);

      if (!isWithinDir(absolute, ctx.cwd)) {
        ctx.ui.notify("Path must be inside the current session directory", "warning");
        return;
      }

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(absolute);
      } catch {
        ctx.ui.notify(`Path not found: ${cleaned}`, "warning");
        return;
      }

      if (!info.isFile() && !info.isDirectory()) {
        ctx.ui.notify("Only files and directories can be ignored", "warning");
        return;
      }

      const result = await appendIgnoreEntry(ctx.cwd, absolute, info.isDirectory());
      if (result.duplicate) {
        ctx.ui.notify("Already ignored", "info");
        return;
      }

      const location = path.relative(ctx.cwd, result.ignoreFile) || FILE_PICKER_IGNORE_FILE;
      ctx.ui.notify(`${result.created ? "Created" : "Updated"} ${location}: ${result.entry}`, "info");
    },
  });

  pi.registerCommand("files:unignore", {
    description: "Remove a file or directory from .pi-ignore",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      if (!raw) {
        ctx.ui.notify("Usage: /files:unignore <path>", "warning");
        return;
      }

      const cleaned = raw.replace(/^@/, "").trim().replace(/\/$/, "");
      const absolute = path.resolve(ctx.cwd, cleaned);

      if (!isWithinDir(absolute, ctx.cwd)) {
        ctx.ui.notify("Path must be inside the current session directory", "warning");
        return;
      }

      const result = await removeIgnoreEntryByPath(ctx.cwd, absolute);
      if (!result.removed || !result.ignoreFile || !result.entry) {
        ctx.ui.notify(`No ignore entry found for: ${cleaned}`, "warning");
        return;
      }

      const location = path.relative(ctx.cwd, result.ignoreFile) || FILE_PICKER_IGNORE_FILE;
      ctx.ui.notify(`Removed ${result.entry} from ${location}`, "info");
    },
  });
}
