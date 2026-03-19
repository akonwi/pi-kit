/**
 * Lazy file scanner ported from `v2/src/features/files/scan-files.ts`.
 *
 * Walks a directory tree respecting:
 * - built-in excludes (.git, node_modules, etc.)
 * - hierarchical .gitignore files
 * - hierarchical .pi-ignore files
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

const MAX_FILES = 4000;
const PI_IGNORE_FILE = ".pi-ignore";

const BUILT_IN_EXCLUDES = new Set([
  ".git",
  "node_modules",
  ".pi",
  ".agents",
  "dist",
  "build",
]);

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function loadIgnoreForDir(dir: string): Promise<Ignore> {
  const ig = ignore();

  const gitignoreContent = await tryReadFile(path.join(dir, ".gitignore"));
  if (gitignoreContent) {
    ig.add(gitignoreContent);
  }

  const piIgnoreContent = await tryReadFile(path.join(dir, PI_IGNORE_FILE));
  if (piIgnoreContent) {
    ig.add(piIgnoreContent);
  }

  return ig;
}

function relativeToBase(base: string, target: string): string {
  const normBase = base.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
  const normTarget = target.replace(/\\/g, "/").replace(/^\.\//, "");

  if (!normBase) return normTarget;
  if (normTarget === normBase) return "";
  if (normTarget.startsWith(`${normBase}/`)) {
    return normTarget.slice(normBase.length + 1);
  }

  return normTarget;
}

export type ScanResult = {
  files: string[];
  dirs: string[];
};

export async function scanFiles(cwd: string): Promise<ScanResult> {
  const files: string[] = [];
  const dirs: string[] = [];

  type IgnoreLayer = {
    base: string;
    ignore: Ignore;
  };

  type StackEntry = {
    dir: string;
    ignoreChain: IgnoreLayer[];
  };

  const rootIgnore = await loadIgnoreForDir(cwd);
  const stack: StackEntry[] = [{ dir: cwd, ignoreChain: [{ base: "", ignore: rootIgnore }] }];

  while (stack.length > 0 && files.length + dirs.length < MAX_FILES) {
    const { dir, ignoreChain } = stack.pop()!;

    let rawEntries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      rawEntries = await readdir(dir, { withFileTypes: true }) as any;
    } catch {
      continue;
    }

    const subdirs: { dir: string; ignoreChain: IgnoreLayer[] }[] = [];

    for (const entry of rawEntries) {
      if (files.length + dirs.length >= MAX_FILES) break;

      const name = String(entry.name);
      const full = path.join(dir, name);
      const relative = path.relative(cwd, full).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (BUILT_IN_EXCLUDES.has(name)) continue;

        const relativeForIgnore = `${relative}/`;
        if (ignoreChain.some((layer) => layer.ignore.ignores(relativeToBase(layer.base, relativeForIgnore)))) continue;

        dirs.push(relativeForIgnore);

        const subIgnore = await loadIgnoreForDir(full);
        subdirs.push({
          dir: full,
          ignoreChain: [...ignoreChain, { base: relative, ignore: subIgnore }],
        });
        continue;
      }

      if (!entry.isFile()) continue;
      if (name === ".gitignore" || name === PI_IGNORE_FILE || name === ".git") continue;
      if (ignoreChain.some((layer) => layer.ignore.ignores(relativeToBase(layer.base, relative)))) continue;

      files.push(relative);
    }

    for (let i = subdirs.length - 1; i >= 0; i--) {
      stack.push(subdirs[i]!);
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  dirs.sort((a, b) => a.localeCompare(b));

  return { files, dirs };
}
