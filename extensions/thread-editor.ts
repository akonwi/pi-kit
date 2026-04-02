/**
 * Thread-aware autocomplete provider and editor.
 *
 * Extends Pi's native autocomplete to handle:
 * - `/` - slash commands (from Pi)
 * - `@` - file references (from Pi)
 * - `@@` - thread references (our addition)
 *
 * The thread picker works like file completion: when user types `@@`,
 * show a fuzzy-searchable list of threads. On selection, insert `@@<id>`.
 */

import { CustomEditor, type EditorTheme } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@mariozechner/pi-tui";
import type { KeybindingsManager, TUI } from "@mariozechner/pi-tui";
import { listSessions, threadTitle, type SessionInfoLite } from "./thread-references";

// --- Thread autocomplete provider ---

export class ThreadAutocompleteProvider implements AutocompleteProvider {
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
    // Look for @@ at the start of a token (after whitespace or start of line)
    const match = text.match(/(?:^|[\s])@@([^\s]*)$/);
    if (match) {
      return `@@${match[1]}`;
    }
    // Also match @@ at the very start with no space before
    if (text.match(/^@@([^\s]*)$/)) {
      return text;
    }
    return null;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
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

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] || "";
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    const afterCursor = currentLine.slice(cursorCol);

    // Insert the thread reference with a trailing space
    const newLine = `${beforePrefix}${item.value} ${afterCursor}`;
    const newLines = [...lines];
    newLines[cursorLine] = newLine;

    const newCol = beforePrefix.length + item.value.length + 1;
    return { lines: newLines, cursorLine, cursorCol: newCol };
  }
}

// --- Combined provider that delegates to both file and thread providers ---

type BaseProvider = AutocompleteProvider & {
  extractAtPrefix?: (text: string) => string | null;
  shouldTriggerFileCompletion?: (lines: string[], cursorLine: number, cursorCol: number) => boolean;
};

export class ThreadAwareAutocompleteProvider implements AutocompleteProvider {
  private baseProvider: BaseProvider | null = null;
  private threadProvider: ThreadAutocompleteProvider;
  private currentSessionPath: string | undefined;

  constructor(
    baseProvider: BaseProvider | null,
    currentSessionPath: string | undefined,
  ) {
    this.baseProvider = baseProvider;
    this.currentSessionPath = currentSessionPath;
    this.threadProvider = new ThreadAutocompleteProvider(currentSessionPath || process.cwd());
  }

  setBaseProvider(provider: BaseProvider): void {
    this.baseProvider = provider;
  }

  setCurrentSessionPath(path: string | undefined): void {
    this.currentSessionPath = path;
    this.threadProvider = new ThreadAutocompleteProvider(path || process.cwd());
  }

  invalidateThreadIndex(): void {
    this.threadProvider.invalidate();
  }

  /**
   * Detect @@ prefix before @ trigger kicks in.
   * We need to handle this ourselves because the base provider triggers on @.
   */
  extractThreadPrefix(text: string): string | null {
    return this.threadProvider.extractThreadPrefix(text);
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
    const threadPrefix = this.extractThreadPrefix(textBeforeCursor);
    if (threadPrefix) {
      return this.threadProvider.getSuggestions(lines, cursorLine, cursorCol, options);
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
      return this.threadProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }

    // Delegate to base provider for @ and /
    if (this.baseProvider) {
      return this.baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }

    // Fallback: simple text replacement
    const currentLine = lines[cursorLine] || "";
    const before = currentLine.slice(0, cursorCol - prefix.length);
    const after = currentLine.slice(cursorCol);
    const newLines = [...lines];
    newLines[cursorLine] = `${before}${item.value} ${after}`;
    return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length + 1 };
  }
}

// --- Thread-aware editor ---

export class ThreadAwareEditor extends CustomEditor {
  private threadProvider: ThreadAwareAutocompleteProvider | null = null;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    threadProvider: ThreadAwareAutocompleteProvider,
    options?: { paddingX?: number; autocompleteMaxVisible?: number },
  ) {
    super(tui, theme, keybindings, options);
    this.threadProvider = threadProvider;
    this.setAutocompleteProvider(threadProvider);
  }

  setThreadProvider(provider: ThreadAwareAutocompleteProvider): void {
    this.threadProvider = provider;
    this.setAutocompleteProvider(provider);
  }

  handleInput(data: string): void {
    // Let the base handle input (which triggers autocomplete)
    super.handleInput(data);
  }
}