import { userInputQuestionsSchema, type UserInputQuestions, type UserInputRequests, type UserInputResult } from "../runtime/userInput.js";
import { ToolAccesses } from "./access.js";
import type { Tool } from "./types.js";

export function createAskUserQuestionTool(requests: UserInputRequests): Tool<UserInputQuestions, UserInputResult> {
  return {
    name: "AskUserQuestion",
    exposure: "model-only",
    description: "Ask one to four focused questions when missing requirements or a decision only the user can provide would materially change the work. Waits for an explicit answer or skip. Every question supports free text, with optional choices.",
    promptSnippet: "Clarify consequential missing requirements with the user, in any interactive mode",
    promptGuidelines: [
      "Before making a consequential assumption about an unclear goal, scope, destination, or irreversible choice, inspect available context and use AskUserQuestion for facts or preferences only the user can supply.",
      "Ask only questions that materially change the result. Prefer a small set of concrete choices with short tradeoffs; always allow a custom answer. Do not ask about facts you can inspect yourself, obvious defaults, or routine implementation details.",
      "Do not request confirmation again for work the user already authorized. A clarification answer is not a tool permission grant.",
      "If the user skips, do not invent an answer or interpret silence as approval. Continue independent authorized work; state a safe assumption only for optional details, and report a blocker when a necessary decision remains missing."
    ],
    parameters: {
      type: "object", properties: {
        questions: { type: "array", minItems: 1, maxItems: 4, items: {
          type: "object", properties: {
            id: { type: "string", description: "Unique stable question id." },
            question: { type: "string", description: "A concise, self-contained question." },
            options: { type: "array", maxItems: 6, items: { type: "object", properties: {
              label: { type: "string" }, description: { type: "string" }
            }, required: ["label"], additionalProperties: false } },
            multiSelect: { type: "boolean", description: "Allow multiple choices; default false." }
          }, required: ["id", "question"], additionalProperties: false
        } }
      }, required: ["questions"], additionalProperties: false
    },
    schema: userInputQuestionsSchema,
    capability: "interaction.ask", risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(), approvalRule: "AskUserQuestion", retrySafety: "unsafe",
        display: { kind: "generic", summary: "等待补充需求", detail: args.questions.map((question) => question.question).join("\n") },
        async execute(context) {
          const completion = requests.request(args, context);
          context.onUpdate?.({ kind: "status", text: "等待你的回答", customKind: "user_input", customData: {
            sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId
          } });
          return await completion;
        }
      };
    }
  };
}
