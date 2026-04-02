/**
 * Thread-aware editor extension.
 *
 * Installs a custom editor that adds `@@` thread completion
 * to Pi's native `@` file completion and `/` command completion.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ThreadAwareEditor, ThreadAwareAutocompleteProvider } from "./thread-editor";

// Global provider so we can invalidate the thread index when needed
let threadAutocompleteProvider: ThreadAwareAutocompleteProvider | null = null;

export function invalidateThreadEditorIndex(): void {
  threadAutocompleteProvider?.invalidateThreadIndex();
}

export default function threadEditorExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Get the current session path for thread lookup
    const currentSessionPath = ctx.sessionManager?.getSessionFile?.();

    // Create the thread-aware autocomplete provider
    const threadProvider = new ThreadAwareAutocompleteProvider(
      null, // Base provider will be set by Pi
      currentSessionPath,
    );
    threadAutocompleteProvider = threadProvider;

    // Install our custom editor that uses the thread-aware autocomplete
    ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
      const editor = new ThreadAwareEditor(tui, theme, keybindings, threadProvider, {
        paddingX: 1, // Match Pi's default
        autocompleteMaxVisible: 8,
      });
      return editor;
    });
  });

  pi.on("session_switch", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Update the thread provider with the new session path
    const currentSessionPath = ctx.sessionManager?.getSessionFile?.();
    threadAutocompleteProvider?.setCurrentSessionPath(currentSessionPath);
    threadAutocompleteProvider?.invalidateThreadIndex();
  });

  // Invalidate thread index after thread-related operations
  pi.events.on("thread-reference:index-refresh", () => {
    threadAutocompleteProvider?.invalidateThreadIndex();
  });
}