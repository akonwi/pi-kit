/**
 * Thinking level command.
 *
 * /thinking [off|minimal|low|medium|high|xhigh|cycle|show]
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

type ThinkingAction = ThinkingLevel | "cycle" | "show";

function parseAction(args: string): ThinkingAction | null {
  const raw = args.trim().toLowerCase();
  if (!raw || raw === "show" || raw === "status") return "show";
  if (raw === "cycle" || raw === "next") return "cycle";
  if (LEVELS.includes(raw as ThinkingLevel)) return raw as ThinkingLevel;
  return null;
}

export default function thinkingExtension(pi: ExtensionAPI): void {
  pi.registerCommand("thinking", {
    description: "Set thinking level: /thinking [off|minimal|low|medium|high|xhigh|cycle|show]",
    handler: async (args, ctx) => {
      const action = parseAction(String(args || ""));
      if (!action) {
        ctx.ui.notify("Usage: /thinking [off|minimal|low|medium|high|xhigh|cycle|show]", "warning");
        return;
      }

      const current = pi.getThinkingLevel?.() || "off";

      if (action === "show") {
        ctx.ui.notify(`Thinking: ${current}`, "info");
        return;
      }

      if (action === "cycle") {
        const idx = LEVELS.indexOf(current as ThinkingLevel);
        const next = LEVELS[(idx + 1) % LEVELS.length] || "off";
        pi.setThinkingLevel(next);
        const applied = pi.getThinkingLevel?.() || next;
        ctx.ui.notify(`Thinking: ${current} → ${applied}`, "info");
        return;
      }

      pi.setThinkingLevel(action);
      const applied = pi.getThinkingLevel?.() || action;
      if (applied !== action) {
        ctx.ui.notify(`Thinking set to ${action} (applied: ${applied})`, "warning");
      } else {
        ctx.ui.notify(`Thinking: ${applied}`, "info");
      }
    },
  });
}
