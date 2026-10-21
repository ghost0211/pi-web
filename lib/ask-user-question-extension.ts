/**
 * `ask_user_question` first-party extension.
 *
 * Lets the model ask a small, structured questionnaire when a decision cannot
 * be inferred: target environment, how to treat existing data, whether to
 * deploy. Answers come back as a tool result, so the model continues in the
 * same run with plain text — no extra model turn, no notification.
 *
 * Transport: the host supplies `ask()`; Pi Web implements it with
 * `requestExtensionUi({ method: "questionnaire" })`, which the browser renders
 * as one panel. Cancellation and aborts resolve to `undefined`, which the tool
 * reports as a decline rather than looping.
 *
 * Limits are enforced here as well as in the panel: a tool call cannot create
 * an unreviewable wall of questions, and the model-facing result is a compact
 * summary instead of the raw payload.
 */
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  formatAnswersAsSnippet,
  parseAskUserQuestionArgs,
  QUESTIONNAIRE_LIMITS,
  type Question,
  type QuestionnaireAnswers,
} from "./ask-user-question";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const HOST_ASK_USER_QUESTION_EXTENSION_NAME = "pi-web-ask-user-question";

export interface AskUserQuestionRuntime {
  /**
   * Show the questionnaire and resolve with the answers, or `undefined` when
   * the user dismissed it / the run was aborted. `title` is the model's optional
   * heading and must reach the panel, or the request loses its context.
   */
  ask(
    questions: Question[],
    toolCallId: string,
    signal?: AbortSignal,
    title?: string,
  ): Promise<QuestionnaireAnswers | undefined>;
}

export function createAskUserQuestionExtension(
  runtime: AskUserQuestionRuntime,
  enabled: () => boolean = () => true,
): InlineExtension {
  return {
    name: HOST_ASK_USER_QUESTION_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: ASK_USER_QUESTION_TOOL_NAME,
        label: "Ask the user",
        // Model-only: a codemode script must not block on a human dialog.
        exposure: "model-only",
        description: [
          "Ask the user one focused question (up to 4) with 2-6 concrete options each.",
          "Use it when a decision cannot be inferred from the conversation and guessing would be expensive: target environment, how to treat existing data, whether to deploy, which of two schemas to follow.",
          "Put the recommended option first and mark it with recommended: true. Each option needs a short description of its impact.",
          "The answer arrives as a tool result; continue in the same run.",
          "Do not use it for small confirmations you can resolve by reading the repository, and do not re-ask after the user dismissed it.",
        ].join(" "),
        promptSnippet: "ask the user a focused multiple-choice question when a decision cannot be inferred",
        promptGuidelines: [
          // Models rarely reach for a brand-new tool on their own, so the trigger
          // has to be spelled out as a situation, not just a capability.
          "When the next step depends on a decision only the user can make (which environment to target, whether to overwrite or keep existing data, which schema or convention to follow), call ask_user_question instead of choosing one silently.",
          "Ask at most one questionnaire per decision point, and prefer one question over several.",
          "A dismissed questionnaire is a decline, not permission: do not immediately re-ask and do not assume an option.",
        ],
        parameters: Type.Object({
          title: Type.Optional(Type.String({ description: "Optional heading for the panel." })),
          questions: Type.Array(
            Type.Object({
              header: Type.String({ description: "Short label, 1-4 words." }),
              question: Type.String({ description: "The question, one or two sentences." }),
              multiSelect: Type.Optional(Type.Boolean({ description: "Allow several options. Default false." })),
              options: Type.Array(
                Type.Object({
                  label: Type.String({ description: "Option label, 1-5 words." }),
                  description: Type.Optional(Type.String({ description: "Impact or trade-off of choosing this." })),
                  preview: Type.Optional(Type.String({ description: "Optional Markdown preview of the result." })),
                  recommended: Type.Optional(Type.Boolean({ description: "Mark as the recommended option." })),
                }),
                { minItems: QUESTIONNAIRE_LIMITS.MIN_OPTIONS, maxItems: QUESTIONNAIRE_LIMITS.MAX_OPTIONS },
              ),
            }),
            { minItems: QUESTIONNAIRE_LIMITS.MIN_QUESTIONS, maxItems: QUESTIONNAIRE_LIMITS.MAX_QUESTIONS },
          ),
        }),
        async execute(toolCallId, params, signal) {
          if (!enabled()) throw new Error("ask_user_question is disabled for this session");
          const parsed = parseAskUserQuestionArgs(params);
          if (!parsed) {
            throw new Error("Invalid questionnaire: check question count, option count, duplicate labels and text length");
          }
          const answers = await runtime.ask(parsed.questions, toolCallId, signal, parsed.title);
          if (!answers) {
            // A decline is information for the model, not an error to retry.
            throw new Error("The user dismissed the questionnaire. Do not re-ask; proceed conservatively or ask in plain text.");
          }
          return {
            content: [{ type: "text", text: formatAnswersAsSnippet(parsed.questions, answers) }],
            details: {
              kind: "pi-web-questionnaire-answers/v1",
              version: 1,
              toolCallId,
              questions: parsed.questions,
              answers,
            },
          };
        },
      }));
    },
  };
}
