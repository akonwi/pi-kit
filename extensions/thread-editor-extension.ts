/**
 * Thread-aware editor extension.
 *
 * Installs a custom editor with @@ thread completion
 * alongside native @ file and / command completion.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ThreadAwareAutocompleteProvider, createThreadAwareEditor } from "./thread-editor";

// Global provider for thread index invalidation
let threadAutocompleteProvider: ThreadAwareAutocompleteProvider | null = null;

export function invalidateThreadEditorIndex(): void {
  threadAutocompleteProvider?.invalidateThreadIndex();
}

export default function threadEditorExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Get slash commands from Pi
    const commands = pi.getCommands();
    const slashCommands = commands.map((c) => ({
      name: c.name,
      description: c.description,
    }));

    // Create thread-aware autocomplete provider with slash commands
    const provider = new ThreadAwareAutocompleteProvider(
      slashCommands,
      ctx.cwd,
      null, // fdPath - let CombinedAutocompleteProvider handle it
    );
    threadAutocompleteProvider = provider;

    // Install custom editor with our provider
    ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
      const editor = createThreadAwareEditor(tui, theme, keybindings, slashCommands, ctx.cwd);
      return editor;
    });
  });

  pi.on("session_switch", async (_event, ctx) => {
    // Invalidate thread index on session switch
    threadAutocompleteProvider?.invalidateThreadIndex();
  });

  pi.events.on("thread-reference:index-refresh", () => {
    threadAutocompleteProvider?.invalidateThreadIndex();
  });
}