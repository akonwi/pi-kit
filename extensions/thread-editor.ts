/**
 * Thread-aware autocomplete provider and editor.
 *
 * Extends Pi's CombinedAutocompleteProvider to add @@ thread completion
 * alongside native @ file completion and / command completion.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { CombinedAutocompleteProvider, type AutocompleteItem, type AutocompleteSuggestions } from "@mariozechner/pi-tui";
import type { KeybindingsManager, TUI } from "@mariozechner/pi-tui";
import { listSessions, threadTitle, type SessionInfoLite } from "./thread-references";

// --- Thread autocomplete component ---

export class ThreadAutocompleteComponent {
  private sessions: SessionInfoLite[] = [];
  private basePath: string;
  private loaded = false;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.sessions = await listSessions(undefined, true);
    this.loaded = true;
  }

  invalidate(): void {
    this.loaded = false;
    this.sessions = [];
  }

  /**
   * Extract @@ prefix from text before cursor.
   * Returns the prefix including @@, or null if not found.
   */
  extractThreadPrefix(text: string): string | null {
    // Match @@ at word boundary (start of line or after whitespace)
    const match = text.match(/(?:^|[\s])@@([^\s]*)$/);
    if (match) {
      return `@@${match[1]}`;
    }
    // Also match @@ at the very start of the line
    if (text.match(/^@@([^\s]*)$/)) {
      return text;
    }
    return null;
  }

  async getThreadSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);

    const threadPrefix = this.extractThreadPrefix(textBeforeCursor);
    if (!threadPrefix) {
      return null;
    }

    await this.ensureLoaded();

    const query = threadPrefix.slice(2).toLowerCase(); // Remove @@
    const matches = this.sessions
      .filter((s) => {
        if (!query) return true;
        return (
          s.id.toLowerCase().includes(query) ||
          (s.name || "").toLowerCase().includes(query) ||
          s.cwd.toLowerCase().includes(query) ||
          (s.firstMessage || "").toLowerCase().includes(query)
        );
      })
      .slice(0, 20);

    if (matches.length === 0) {
      return null;
    }

    return {
      items: matches.map((s) => ({
        value: `@@${s.id.slice(0, 8)}`,
        label: threadTitle(s),
        description: `${s.cwd} · ${s.id.slice(0, 8)}`,
      })),
      prefix: threadPrefix,
    };
  }

  applyThreadCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] || "";
    const before = currentLine.slice(0, cursorCol - prefix.length);
    const after = currentLine.slice(cursorCol);
    const newLine = `${before}${item.value} ${after}`;
    const newLines = [...lines];
    newLines[cursorLine] = newLine;
    return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length + 1 };
  }
}

// --- Combined provider with thread support ---

export class ThreadAwareAutocompleteProvider implements AutocompleteProvider {
  private baseProvider: CombinedAutocompleteProvider | null = null;
  private threadComponent: ThreadAutocompleteComponent;

  constructor(
    slashCommands: Array<{ name: string; description?: string; getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null }>,
    basePath: string,
    fdPath: string | null = null,
  ) {
    this.baseProvider = new CombinedAutocompleteProvider(slashCommands, basePath, fdPath);
    this.threadComponent = new ThreadAutocompleteComponent(basePath);
  }

  setSlashCommands(commands: Array<{ name: string; description?: string }>): void {
    if (this.baseProvider) {
      (this.baseProvider as any).commands = commands;
    }
  }

  invalidateThreadIndex(): void {
    this.threadComponent.invalidate();
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] || "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);

    // Check for @@ thread prefix first
    const threadPrefix = this.threadComponent.extractThreadPrefix(textBeforeCursor);
    if (threadPrefix) {
      return this.threadComponent.getThreadSuggestions(lines, cursorLine, cursorCol, options);
    }

    // Delegate to base provider for @ and /
    if (this.baseProvider) {
      return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    return null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    // Thread completions start with @@
    if (prefix.startsWith("@@") || item.value.startsWith("@@")) {
      return this.threadComponent.applyThreadCompletion(lines, cursorLine, cursorCol, item, prefix);
    }

    // Delegate to base provider
    if (this.baseProvider) {
      return this.baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }

    // Fallback
    const currentLine = lines[cursorLine] || "";
    const before = currentLine.slice(0, cursorCol - prefix.length);
    const after = currentLine.slice(cursorCol);
    const newLines = [...lines];
    newLines[cursorLine] = `${before}${item.value} ${after}`;
    return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length + 1 };
  }
}

// --- Editor factory ---

export function createThreadAwareEditor(
  tui: TUI,
  theme: any,
  keybindings: KeybindingsManager,
  slashCommands: Array<{ name: string; description?: string }>,
  basePath: string,
): CustomEditor {
  const provider = new ThreadAwareAutocompleteProvider(slashCommands, basePath, null);
  
  const editor = new CustomEditor(tui, theme, keybindings, {
    paddingX: 1,
    autocompleteMaxVisible: 8,
  });
  
  editor.setAutocompleteProvider(provider);
  
  return editor;
}