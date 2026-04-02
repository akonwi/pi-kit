/**
 * pi-kit extension — orchestrator for all pi-kit features.
 *
 * This file wires together the individual feature modules:
 * - notifications: /bells and /speech commands
 * - session-naming: auto session title generation
 * - handoff: /handoff command for creating child threads
 * - wizard: guided_questions tool and /wizard command
 * - pager: /pager command for long responses
 * - session-commands: /threads, /switch, /threads:manage
 * - footer: custom status bar
 * - thread-editor: @@ thread completion in editor
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Feature modules
import notificationsExtension from "./notifications";
import sessionNamingExtension from "./session-naming";
import handoffExtension from "./handoff";
import wizardExtension from "./wizard";
import pagerExtension from "./pager";
import sessionCommandsExtension from "./session-commands";
import footerExtension from "./footer";
import threadEditorExtension from "./thread-editor-extension";
import ignoreExtension from "./ignore";

// --- Extension factory ---

export default function piKitExtension(pi: ExtensionAPI): void {
  // --- Load feature modules ---

  // Each module registers its own commands, tools, and event handlers
  notificationsExtension(pi);
  sessionNamingExtension(pi);
  handoffExtension(pi);
  wizardExtension(pi);
  pagerExtension(pi);
  sessionCommandsExtension(pi);
  footerExtension(pi);
  threadEditorExtension(pi);
  ignoreExtension(pi);
}