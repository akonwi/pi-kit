/**
 * Thread-aware autocomplete provider and editor.
 *
 * Wraps Pi's CombinedAutocompleteProvider to add @@ thread completion
 * alongside native @ file and / command completion.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteSuggestions } from "@mariozechner/pi-tui";
import type { KeybindingsManager, TUI } from "@mariozechner/pi-tui";
import { listSessions, threadTitle, type SessionInfoLite } from "./thread-references";

// --- Thread autocomplete component ---

class ThreadAutocompleteComponent {
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

    const query = threadPrefix.slice(2).toLowerCase();
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

// --- Wrapper provider that adds thread support ---

class ThreadAwareAutocompleteProvider implements AutocompleteProvider {
  private baseProvider: AutocompleteProvider | null = null;
  private threadComponent: ThreadAutocompleteComponent;

  constructor(baseProvider: AutocompleteProvider | null, basePath: string) {
    this.baseProvider = baseProvider;
    this.threadComponent = new ThreadAutocompleteComponent(basePath);
  }

  setBaseProvider(provider: AutocompleteProvider): void {
    this.baseProvider = provider;
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
    return this.baseProvider?.getSuggestions(lines, cursorLine, cursorCol, options) ?? null;
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

    return this.baseProvider?.applyCompletion(lines, cursorLine, cursorCol, item, prefix) ?? 
      { lines, cursorLine, cursorCol };
  }
}

// --- Thread-aware editor that wraps Pi's autocomplete ---

let threadProvider: ThreadAwareAutocompleteProvider | null = null;

export class ThreadAwareEditor extends CustomEditor {
  private threadAutocompleteProvider: ThreadAwareAutocompleteProvider;

  constructor(
    tui: TUI,
    theme: any,
    keybindings: KeybindingsManager,
    threadProvider: ThreadAwareAutocompleteProvider,
    options?: { paddingX?: number; autocompleteMaxVisible?: number },
  ) {
    super(tui, theme, keybindings, options);
    this.threadAutocompleteProvider = threadProvider;
    // Don't set autocomplete here - Pi will call setAutocompleteProvider later
  }

  /**
   * Override to wrap Pi's autocomplete provider with thread support.
   * Pi calls this after creating the editor.
   */
  override setAutocompleteProvider(provider: AutocompleteProvider | null): void {
    // Wrap Pi's provider (commands + files) with our thread support
    this.threadAutocompleteProvider.setBaseProvider(provider);
    super.setAutocompleteProvider(this.threadAutocompleteProvider);
  }
}

export function createThreadAwareEditor(
  tui: TUI,
  theme: any,
  keybindings: KeybindingsManager,
  basePath: string,
): ThreadAwareEditor {
  // Create the thread provider - base will be set when Pi calls setAutocompleteProvider
  threadProvider = new ThreadAwareAutocompleteProvider(null, basePath);
  
  return new ThreadAwareEditor(tui, theme, keybindings, threadProvider, {
    paddingX: 1,
    autocompleteMaxVisible: 8,
  });
}

export function invalidateThreadIndex(): void {
  threadProvider?.invalidateThreadIndex();
}