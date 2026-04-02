/**
 * wizard extension — guided questions tool and /wizard command.
 *
 * Provides a structured questionnaire UI for collecting multiple
 * clarifying answers from the user.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { openWizardScreen } from "./ui/screens/wizard-screen";
import { normalizeQuestion, type GuidedQuestion, type GuidedQuestionnaireInput } from "./ui/input-surfaces/wizard-input";
import { setActiveEditorRenderDelegate } from "./ui/thread-reference-shell";
import { sharedInteractionDock, sharedScreenManager } from "./ui/shell";
import { createThreadScreen } from "./ui/screens/thread-screen";

const GUIDED_QUESTIONS_POLICY = [
  "When you need clarification from the user and there are 2 or more missing inputs, call guided_questions instead of asking a long list in plain chat.",
  "Keep questions short and concrete.",
  "Prefer select/boolean questions when possible, and only use free text when necessary.",
  "After guided_questions returns, proceed using details.answers as source-of-truth.",
].join("\n");

// --- Helpers ---

function messageText(msg: AgentMessage): string {
  const content: unknown = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractQuestionsFromAssistantText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const cleaned = value
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^q:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return;
    if (!cleaned.includes("?")) return;
    const canonical = cleaned.toLowerCase();
    if (seen.has(canonical)) return;
    seen.add(canonical);
    out.push(cleaned);
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/\?$/.test(trimmed) || /^[-*+]\s+.*\?$/.test(trimmed) || /^\d+[.)]\s+.*\?$/.test(trimmed)) {
      push(trimmed);
      continue;
    }

    const sentenceMatches = trimmed.match(/[^?\n]{3,220}\?/g) || [];
    for (const candidate of sentenceMatches) push(candidate);
  }

  if (out.length === 0) {
    const paragraphMatches = text.replace(/\s+/g, " ").match(/[^?]{3,220}\?/g) || [];
    for (const candidate of paragraphMatches) push(candidate);
  }

  return out.slice(0, 10);
}

function buildWizardFromLastAssistant(ctx: any): GuidedQuestionnaireInput | null {
  const branch = Array.isArray(ctx.sessionManager?.getBranch?.()) ? ctx.sessionManager.getBranch() : [];
  let lastAssistant: AgentMessage | undefined;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
    lastAssistant = entry.message as AgentMessage;
    break;
  }

  if (!lastAssistant) return null;

  const text = messageText(lastAssistant).trim();
  if (!text) return null;

  const questions = extractQuestionsFromAssistantText(text).map((label, idx) => ({
    id: `q${idx + 1}`,
    kind: "text" as const,
    label,
    required: true,
  }));

  if (questions.length === 0) return null;

  return {
    title: "Clarify missing details",
    intro: "Answer the assistant's pending questions using the wizard.",
    questions,
  };
}

// --- Main ---

export async function runGuidedQuestionnaire(
  ctx: any,
  params: GuidedQuestionnaireInput,
): Promise<{
  contentText: string;
  details: Record<string, unknown>;
}> {
  if (!ctx.hasUI) {
    return {
      contentText: "guided_questions requires interactive mode with UI.",
      details: { cancelled: true, reason: "no-ui" },
    };
  }

  const questions = (Array.isArray(params.questions) ? params.questions : []).map(normalizeQuestion);
  if (questions.length === 0) {
    return {
      contentText: "No questions were provided.",
      details: { cancelled: true, reason: "empty" },
    };
  }

  const dockController = sharedInteractionDock;
  const screenManager = sharedScreenManager;

  const { screen, result } = openWizardScreen({
    ctx,
    params: { ...params, questions },
    dock: dockController,
    setRenderDelegate: setActiveEditorRenderDelegate,
    onClosed: () => {
      screenManager.clearIfActive(screen);
      screenManager.activate(createThreadScreen(dockController));
    },
  });
  screenManager.activate(screen);

  const wizardResult = await result;

  const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "Guided questionnaire";
  const answers = wizardResult.answers;

  if (wizardResult.cancelled) {
    return {
      contentText: "Questionnaire cancelled.",
      details: {
        cancelled: true,
        answers,
        answeredCount: Object.keys(answers).length,
        totalQuestions: questions.length,
      },
    };
  }

  const summaryLines = questions.map((q) => {
    const value = answers[q.id];
    const rendered = typeof value === "boolean" ? (value ? "Yes" : "No") : (String(value || "").trim() || "(skipped)");
    return `- ${q.label}: ${rendered}`;
  });

  return {
    contentText: [`${title} complete.`, "", ...summaryLines].join("\n"),
    details: {
      title,
      answers,
      answeredCount: Object.keys(answers).length,
      totalQuestions: questions.length,
      completed: true,
    },
  };
}

export default function wizardExtension(pi: ExtensionAPI): void {
  // Inject guided_questions policy into system prompt when tool is active
  pi.on("before_agent_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!pi.getActiveTools().includes("guided_questions")) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${GUIDED_QUESTIONS_POLICY}`,
    };
  });

  // Register the guided_questions tool
  pi.registerTool({
    name: "guided_questions",
    label: "Guided Questions",
    description: "Ask the user a structured, one-question-at-a-time questionnaire in the terminal UI.",
    promptSnippet: "Collect structured user answers via an interactive questionnaire when multiple clarifying questions are needed.",
    promptGuidelines: [
      "Use this tool when you need 2+ clarifying answers from the user.",
      "Prefer short labels and constrained choices for select questions.",
      "After the tool returns, continue using the structured answers directly.",
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Short title shown to the user" })),
      intro: Type.Optional(Type.String({ description: "Optional intro shown before the first question" })),
      questions: Type.Array(Type.Object({
        id: Type.String({ description: "Stable key for the answer" }),
        kind: Type.Optional(Type.String({ description: "text | select | boolean" })),
        label: Type.String({ description: "Question shown to the user" }),
        help: Type.Optional(Type.String({ description: "Optional helper text" })),
        placeholder: Type.Optional(Type.String({ description: "Placeholder for text input" })),
        required: Type.Optional(Type.Boolean({ description: "Whether answer is required (default true)" })),
        options: Type.Optional(Type.Array(Type.String(), { description: "Options for select questions" })),
      }), { minItems: 1, maxItems: 12 }),
    }),
    execute: async (_toolCallId, input, _signal, _onUpdate, ctx) => {
      const result = await runGuidedQuestionnaire(ctx, input as GuidedQuestionnaireInput);
      return {
        content: [{ type: "text", text: result.contentText }],
        details: result.details,
      };
    },
  });

  // Register /wizard command
  pi.registerCommand("wizard", {
    description: "Run guided questions from last assistant message (use --demo for sample)",
    handler: async (args, ctx) => {
      const raw = String(args || "").trim().toLowerCase();
      const useDemo = raw === "--demo" || raw === "demo";

      const sampleQuestions: GuidedQuestionnaireInput = {
        title: "Project intake",
        intro: "Answer a few quick questions so I can tailor implementation.",
        questions: [
          { id: "goal", kind: "text", label: "What is the primary goal?", placeholder: "e.g. add Stripe subscriptions" },
          { id: "stack", kind: "select", label: "Which stack are we working in?", options: ["Next.js", "Node", "Python", "Other"], required: true },
          { id: "strict", kind: "boolean", label: "Should I optimize for strict type safety first?", required: true },
        ],
      };

      const inferred = buildWizardFromLastAssistant(ctx);
      const questionnaire = useDemo ? sampleQuestions : (inferred || sampleQuestions);

      if (!useDemo && !inferred) {
        ctx.ui.notify("No clear questions found in last assistant message; using demo questionnaire. Use /wizard --demo anytime.", "info");
      }

      const result = await runGuidedQuestionnaire(ctx, questionnaire);
      ctx.ui.notify(result.contentText, "info");

      const answers = (result.details.answers || {}) as Record<string, unknown>;
      if (Object.keys(answers).length > 0) {
        pi.sendUserMessage([
          {
            type: "text",
            text: [
              "Questionnaire answers:",
              "```json",
              JSON.stringify(answers, null, 2),
              "```",
              "Use these answers as the source of truth and proceed.",
            ].join("\n"),
          },
        ]);
      }
    },
  });
}