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
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isKeyRelease } from "@mariozechner/pi-tui";
import {
  ensureThreadReferenceEditorInstalled,
  handleThreadReferenceHandoff,
  handleThreadReferenceUserBash,
  refreshThreadReferenceComposer,
  refreshThreadReferenceIndexes,
  setActiveEditorRenderDelegate,
  setThreadReferenceDockState,
} from "./ui/thread-reference-shell";
import { sharedInteractionDock, sharedScreenManager, UI_EVENT_KEYS } from "./ui/shell";
import { createThreadScreen } from "./ui/screens/thread-screen";

// Feature modules
import notificationsExtension from "./notifications";
import sessionNamingExtension from "./session-naming";
import handoffExtension from "./handoff";
import wizardExtension from "./wizard";
import pagerExtension from "./pager";
import sessionCommandsExtension from "./session-commands";
import footerExtension from "./footer";

// --- Screen input routing ---

function installScreenInputRouter(ctx: any): void {
  if (!ctx.hasUI) return;

  ctx.ui.onTerminalInput((data: string) => {
    if (isKeyRelease(data)) {
      return undefined;
    }

    const dockController = sharedInteractionDock;
    const screenManager = sharedScreenManager;

    const dockResult = dockController.handleInput(data);
    if (dockResult?.consume) return dockResult;

    const nextData = dockResult?.data !== undefined ? dockResult.data : data;

    if (dockController.blocksScreenInput()) {
      return undefined;
    }

    return screenManager.handleInput(nextData);
  });
}

// --- Main extension factory ---

export default function piKitExtension(pi: ExtensionAPI): void {
  const dockController = sharedInteractionDock;
  const screenManager = sharedScreenManager;

  // Configure the dock controller
  dockController.configure({
    onRefresh: () => {
      refreshThreadReferenceComposer();
      pi.events.emit(UI_EVENT_KEYS.dockRefresh);
    },
    onStateChange: (state) => {
      setThreadReferenceDockState(state);
      pi.events.emit(UI_EVENT_KEYS.dockStateChanged, state);
    },
    onMetricsChange: (metrics) => {
      pi.events.emit(UI_EVENT_KEYS.dockMetricsChanged, metrics);
    },
  });

  // Sync dock metrics
  pi.events.on(UI_EVENT_KEYS.dockMetricsChanged, (metrics) => {
    if (!metrics) return;
    dockController.setMetrics(metrics);
  });

  // Thread screen activation helper
  const activateThreadScreen = () => {
    screenManager.activate(createThreadScreen(dockController));
  };

  // --- Lifecycle events ---

  pi.on("session_start", async (_event, ctx) => {
    await ensureThreadReferenceEditorInstalled(pi, ctx);
    installScreenInputRouter(ctx);
    activateThreadScreen();
  });

  pi.on("session_switch", async (_event, ctx) => {
    await ensureThreadReferenceEditorInstalled(pi, ctx);
    // Restore thread screen on session switch
    activateThreadScreen();
  });

  pi.on("agent_start", async (_event, ctx) => {
    await ensureThreadReferenceEditorInstalled(pi, ctx);
  });

  pi.on("user_bash", async (event, ctx) => {
    handleThreadReferenceUserBash(event, ctx);
  });

  // Thread reference events
  pi.events.on("thread:handoff", (data?: { stay?: boolean }) => {
    handleThreadReferenceHandoff(data);
  });

  pi.events.on("thread-reference:index-refresh", (data?: { files?: boolean; threads?: boolean }) => {
    void refreshThreadReferenceIndexes(data);
  });

  // --- Load feature modules ---

  // Each module registers its own commands, tools, and event handlers
  notificationsExtension(pi);
  sessionNamingExtension(pi);
  handoffExtension(pi);
  wizardExtension(pi);
  pagerExtension(pi);
  sessionCommandsExtension(pi);
  footerExtension(pi);
}