import { z } from "zod";

const questionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  question: z.string().trim().min(1).max(2000),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    description: z.string().trim().max(500).optional()
  }).strict()).max(6).default([]),
  multiSelect: z.boolean().default(false)
}).strict().refine((question) => new Set(question.options.map((option) => option.label)).size === question.options.length, "Option labels must be unique.");
export const userInputQuestionsSchema = z.object({ questions: z.array(questionSchema).min(1).max(4) }).strict()
  .refine((input) => new Set(input.questions.map((question) => question.id)).size === input.questions.length, "Question ids must be unique.");
export type UserInputQuestions = z.infer<typeof userInputQuestionsSchema>;
export const userInputResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("answered"), answers: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    selected: z.array(z.string().trim().min(1).max(200)).max(6),
    text: z.string().trim().max(4000).optional()
  }).strict()).min(1).max(4) }).strict(),
  z.object({ status: z.literal("skipped") }).strict()
]);
export type UserInputResponse = z.infer<typeof userInputResponseSchema>;
export interface PendingUserInput extends UserInputQuestions {
  sessionId: string;
  runId: string;
  toolCallId: string;
}
export interface UserInputResult extends UserInputQuestions { response: UserInputResponse }

/** 活动回合拥有等待；tool_call/tool_result 负责持久化问题与答案。 */
export class UserInputRequests {
  private owner?: { sessionId: string; runId: string };
  private readonly pending = new Map<string, {
    request: PendingUserInput;
    resolve(result: UserInputResult): void;
    reject(error: Error): void;
    cleanup(): void;
  }>();

  setRun(run?: { sessionId: string; runId: string }): void {
    if (this.owner?.runId === run?.runId && this.owner?.sessionId === run?.sessionId) return;
    for (const wait of this.pending.values()) {
      wait.cleanup();
      wait.reject(new Error("User input request cancelled because its run ended."));
    }
    this.pending.clear();
    this.owner = run;
  }

  list(): PendingUserInput[] {
    return [...this.pending.values()].map((wait) => structuredClone(wait.request));
  }

  request(input: UserInputQuestions, context: { sessionId?: string; runId?: string; toolCallId: string; signal?: AbortSignal }): Promise<UserInputResult> {
    const questions = userInputQuestionsSchema.parse(input);
    const owner = this.owner;
    if (!owner || owner.sessionId !== context.sessionId || owner.runId !== context.runId) {
      throw new Error("Interactive user input is unavailable for this run. Ask in the final response and report the missing input.");
    }
    context.signal?.throwIfAborted();
    if (this.pending.has(context.toolCallId)) throw new Error("User input request is already pending.");
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(context.toolCallId);
        cleanup();
        reject(new Error("User input request cancelled."));
      };
      const cleanup = (): void => context.signal?.removeEventListener("abort", abort);
      this.pending.set(context.toolCallId, { request: { ...owner, toolCallId: context.toolCallId, ...questions }, resolve, reject, cleanup });
      context.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  answer(sessionId: string, runId: string, toolCallId: string, input: unknown): UserInputResult {
    const wait = this.pending.get(toolCallId);
    if (!wait || wait.request.sessionId !== sessionId || wait.request.runId !== runId) throw new Error("User input request is no longer pending in this session and run.");
    const response = userInputResponseSchema.parse(input);
    if (response.status === "answered") {
      if (response.answers.length !== wait.request.questions.length || new Set(response.answers.map((answer) => answer.id)).size !== response.answers.length) throw new Error("Answer each question exactly once.");
      for (const question of wait.request.questions) {
        const answer = response.answers.find((value) => value.id === question.id);
        if (!answer || (!answer.selected.length && !answer.text)) throw new Error(`Missing answer for question ${question.id}.`);
        if ((!question.multiSelect && answer.selected.length > 1)
          || new Set(answer.selected).size !== answer.selected.length
          || answer.selected.some((label) => !question.options.some((option) => option.label === label))) throw new Error(`Invalid selection for question ${question.id}.`);
      }
    }
    const result = { questions: wait.request.questions, response };
    this.pending.delete(toolCallId);
    wait.cleanup();
    wait.resolve(result);
    return result;
  }
}
