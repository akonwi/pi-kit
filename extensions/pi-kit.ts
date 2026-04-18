/**
 * pi-kit extension — single entry point for all pi-kit features.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import notificationsExtension from "./notifications";
import sessionNamingExtension from "./session-naming";
import handoffExtension from "./handoff";
import wizardExtension from "./wizard";
import pagerExtension from "./pager";
import sessionCommandsExtension from "./session-commands";
import footerExtension from "./footer";
import threadEditorExtension from "./thread-editor-extension";
import ignoreExtension from "./ignore";
import threadReferencesExtension from "./thread-references";
import protectedPathsExtension from "./protected-paths";
import claudeCommandsExtension from "./claude-commands";
import thinkingExtension from "./thinking";

export default function piKitExtension(pi: ExtensionAPI): void {
  notificationsExtension(pi);
  sessionNamingExtension(pi);
  handoffExtension(pi);
  wizardExtension(pi);
  pagerExtension(pi);
  sessionCommandsExtension(pi);
  footerExtension(pi);
  threadEditorExtension(pi);
  ignoreExtension(pi);
  threadReferencesExtension(pi);
  protectedPathsExtension(pi);
  claudeCommandsExtension(pi);
  thinkingExtension(pi);
}
