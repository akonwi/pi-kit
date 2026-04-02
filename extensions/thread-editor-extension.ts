/**
 * Thread-aware editor extension.
 *
 * Installs a custom editor with @@ thread completion
 * alongside native @ file and / command completion.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createThreadAwareEditor, invalidateThreadIndex } from "./thread-editor";

export default function threadEditorExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Install custom editor that wraps autocomplete with thread support
    ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
      return createThreadAwareEditor(tui, theme, keybindings, ctx.cwd);
    });
  });

  pi.on("session_switch", async (_event, ctx) => {
    // Invalidate thread index on session switch
    invalidateThreadIndex();
  });

  pi.events.on("thread-reference:index-refresh", () => {
    invalidateThreadIndex();
  });
}