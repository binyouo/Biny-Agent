import React, { useId, useRef, useState } from "react";
import { userInputQuestionsSchema, userInputResponseSchema, type UserInputResponse } from "../../../../../runtime/userInput.js";
import type { TimelineTool } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";
import { ToolPermission } from "../ToolActivity.js";

type QuestionDraft = { selected: string[]; text: string };

function questionDraft(drafts: Record<string, QuestionDraft>, id: string): QuestionDraft | undefined {
  return Object.hasOwn(drafts, id) ? drafts[id] : undefined;
}

export function UserInputCard({ tool, projectId, sessionId, running }: {
  tool: TimelineTool;
  projectId: string;
  sessionId?: string;
  running: boolean;
}): React.JSX.Element {
  const formId = useId();
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<UserInputResponse>();
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const input = userInputQuestionsSchema.safeParse(tool.args);
  const result = userInputResponseSchema.safeParse((tool.result as { response?: unknown } | undefined)?.response);
  const response = result.success ? result.data : submitted;
  const waitingPermission = tool.permission && !tool.permission.resolved;
  const pending = running && (tool.status === "running" || tool.status === "waiting") && !response && !waitingPermission;
  const disabled = !pending || submitting || !sessionId || !tool.runId;
  const questions = input.success ? input.data.questions : [];
  const canSubmit = questions.length > 0 && questions.every((question) => questionDraft(drafts, question.id)?.selected.length || questionDraft(drafts, question.id)?.text.trim());
  const submit = async (answer: UserInputResponse): Promise<void> => {
    if (disabled || inFlight.current || !sessionId || !tool.runId) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await window.biny.answerUserInput(projectId, sessionId, tool.runId, tool.id, answer);
      setSubmitted(answer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };
  const label = response?.status === "answered" ? "已回答" : response?.status === "skipped" ? "已跳过"
    : waitingPermission ? "等待确认" : pending ? "等待你的回答" : "提问已结束";
  return <><details className="user-input-card" open={pending} aria-label="补充需求">
    <summary><Icon name={response?.status === "answered" ? "check" : "message"} size={16} /><span>{label}</span><Icon name="chevron" size={14} /></summary>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (canSubmit) void submit({ status: "answered", answers: questions.map((question) => ({ id: question.id, selected: questionDraft(drafts, question.id)?.selected ?? [], text: questionDraft(drafts, question.id)?.text.trim() || undefined })) });
    }}>
      {questions.map((question) => {
        const answer = response?.status === "answered" ? response.answers.find((entry) => entry.id === question.id) : undefined;
        const draft = questionDraft(drafts, question.id) ?? { selected: [], text: "" };
        const selected = answer?.selected ?? draft.selected;
        return <fieldset key={question.id} disabled={disabled}>
          <legend>{question.question}</legend>
          {question.options.map((option) => <label className="user-input-option" key={option.label}>
            <input type={question.multiSelect ? "checkbox" : "radio"} name={`${formId}-${question.id}`} value={option.label} checked={selected.includes(option.label)}
              onChange={() => setDrafts((current) => ({ ...current, [question.id]: {
                text: question.multiSelect ? questionDraft(current, question.id)?.text ?? "" : "",
                selected: question.multiSelect ? selected.includes(option.label) ? selected.filter((value) => value !== option.label) : [...selected, option.label] : [option.label]
              } }))} />
            <span><span>{option.label}</span>{option.description ? <small>{option.description}</small> : null}</span>
          </label>)}
          {pending ? <label className="user-input-custom"><span>{question.options.length ? question.multiSelect ? "补充或填写其他答案" : "其他答案" : "你的回答"}</span>
            <textarea value={draft.text} maxLength={4000} rows={2} onChange={(event) => setDrafts((current) => ({ ...current, [question.id]: { selected: question.multiSelect ? questionDraft(current, question.id)?.selected ?? [] : [], text: event.target.value } }))} />
          </label> : answer?.text ? <p className="user-input-answer">{answer.text}</p> : null}
        </fieldset>;
      })}
      {!input.success ? <p role="alert">问题内容无效，请在聊天中补充需求。</p> : null}
      {error || tool.error ? <p className="user-input-error" role="alert">{error ?? tool.error}</p> : null}
      {pending ? <div className="user-input-actions">
        <button type="button" disabled={disabled} onClick={() => void submit({ status: "skipped" })}>跳过</button>
        <button type="submit" disabled={disabled || !canSubmit}>{submitting ? "提交中…" : "提交回答"}</button>
      </div> : null}
    </form>
  </details><ToolPermission tool={tool} onResolvePermission={async (requestId, result) => await window.biny.resolvePermission(projectId, requestId, result)} /></>;
}
