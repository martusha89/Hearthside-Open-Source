import type { AnyAgentTool, CanUseToolResponse } from "@letta-ai/letta-agent-sdk";

/**
 * Hearthside: a question tool the agent can actually use. The SDK hides the
 * runtime's own AskUserQuestion from sessions, so we register this one through
 * the SDK's supported custom-tool option. It shows the questions in the app and
 * waits for the person's answer, which becomes the tool's result.
 */

export const QUESTION_TOOL_NAME = "ask_user_question";

type Question = {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

const parameters = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description: "1-4 questions to ask the user at once.",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The full question, ending with a question mark." },
          header: { type: "string", description: "A very short label for the question (a few words)." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description: "2-4 choices. The user can always type their own answer instead.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "The choice, in 1-5 words." },
                description: { type: "string", description: "What choosing it means." },
              },
              required: ["label"],
            },
          },
          multiSelect: { type: "boolean", description: "Allow choosing more than one option." },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["questions"],
};

function parseQuestions(args: unknown): Question[] | null {
  const questions = (args as { questions?: unknown })?.questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) return null;
  const valid = questions.every(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof (item as Question).question === "string" &&
      (item as Question).question.trim() &&
      ((item as Question).options === undefined || Array.isArray((item as Question).options)),
  );
  return valid ? (questions as Question[]) : null;
}

/** The answer text the agent receives. */
export function answerText(questions: Question[], response: CanUseToolResponse): string {
  if (response.behavior !== "allow") {
    return response.message && /stopped|ended/i.test(response.message)
      ? "The question was cancelled before the user answered."
      : "The user skipped the question without answering.";
  }
  const answers = ((response.updatedInput as { answers?: Record<string, string> } | undefined)?.answers ?? {}) as Record<string, string>;
  const lines = questions.map((q) => `- ${q.question}\n  Answer: ${answers[q.question]?.trim() || "(no answer)"}`);
  return `The user answered:\n${lines.join("\n")}`;
}

/**
 * @param ask shows the questions and resolves with the person's decision
 *   (an approval-style response whose updatedInput carries `answers`).
 */
export function createQuestionTool(
  ask: (toolCallId: string, input: Record<string, unknown>) => Promise<CanUseToolResponse>,
): AnyAgentTool {
  return {
    name: QUESTION_TOOL_NAME,
    label: "Ask the user",
    description:
      "Ask the user one to four multiple-choice questions and wait for their answer. Use it when you need the user's choice or preference before continuing. Each question offers 2-4 options; the user can also type their own answer or skip. The result contains their answers.",
    parameters,
    execute: async (toolCallId, args) => {
      const questions = parseQuestions(args);
      if (!questions) {
        return {
          content: [{ type: "text", text: "Expected 1-4 questions, each with a question and 2-4 options." }],
          isError: true,
        };
      }
      const response = await ask(toolCallId, { questions });
      return { content: [{ type: "text", text: answerText(questions, response) }] };
    },
  };
}
