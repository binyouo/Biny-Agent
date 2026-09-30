/**
 * 用户消息的展示文本提取。
 *
 * 早期 Durable Task 写进 session 的 user_message 可能包了一层验收脚手架。当前普通 Loop
 * 不再生成这种消息，但回放旧 session 时仍要只展示用户真正输入的部分。
 */
const verifierAttemptMarker = "\n\nThis is a verifier-driven task.";
const continuationPrefix = "Continue the same project-level task autonomously.";
const originalObjectivePrefix = "\n\nOriginal objective: ";
const previousFeedbackPrefix = "\n\nPrevious attempt feedback:";
const skillWrapperPattern = /^<skill\b[^>]*\bname="([^"]+)"[^>]*>/u;
const skillWrapperEnd = "</skill>";
const notificationOpenTag = "<biny_notification>";
const notificationBlockPattern = /<biny_notification>[\s\S]*?<\/biny_notification>/gu;

/** 取出消息中面向用户的那一段；识别不出脚手架时原样返回。 */
export function publicUserMessage(content: string): string {
  const skillMatch = content.match(skillWrapperPattern);
  if (skillMatch?.[1]) {
    const wrapperEnd = content.indexOf(skillWrapperEnd, skillMatch[0].length);
    const task = wrapperEnd === -1 ? "" : content.slice(wrapperEnd + skillWrapperEnd.length).trim();
    return task ? `Skill: ${skillMatch[1]}\n\n${task}` : `Skill: ${skillMatch[1]}`;
  }

  // 首次尝试：脚手架追加在用户输入之后，截到标记为止。
  const firstAttemptMarker = content.indexOf(verifierAttemptMarker);
  if (firstAttemptMarker > 0) return content.slice(0, firstAttemptMarker).trimEnd();
  if (!content.startsWith(continuationPrefix)) return content;

  // 续跑尝试：用户输入被夹在「原始目标」和「上次反馈」之间，取中间那段。
  const objectiveStart = content.indexOf(originalObjectivePrefix);
  const feedbackStart = content.indexOf(previousFeedbackPrefix, objectiveStart + originalObjectivePrefix.length);
  if (objectiveStart === -1 || feedbackStart === -1 || feedbackStart <= objectiveStart) return content;
  return content.slice(objectiveStart + originalObjectivePrefix.length, feedbackStart).trim();
}

/**
 * 隐藏后台通知协议，只返回可以进入聊天界面的 assistant 正文。
 *
 * 完整块用于清理旧 session；流式输出还可能只到达起始标签的一部分，因此也要扣住与
 * 起始标签匹配的末尾前缀，避免 XML 在下一帧补全前短暂闪到界面上。
 */
export function publicAssistantMessage(content: string): string {
  content = stripReasoningEnvelope(content);
  // 先去掉每个完整块，保留块之间的正文；不能把首个开始标签到最后一个结束标签一并吞掉。
  content = content.replace(notificationBlockPattern, "");

  const openTagIndex = content.indexOf(notificationOpenTag);
  if (openTagIndex >= 0) return content.slice(0, openTagIndex);

  for (let length = Math.min(content.length, notificationOpenTag.length - 1); length > 0; length -= 1) {
    if (content.endsWith(notificationOpenTag.slice(0, length))) {
      return content.slice(0, -length);
    }
  }
  return content;
}

/** 隔离误写入正文的思考协议；代码围栏中的标签仍是用户内容，不参与解析。 */
function stripReasoningEnvelope(content: string): string {
  let output = "";
  let thinking = false;
  let fence: string | undefined;
  for (const sourceLine of content.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    let line = sourceLine;
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (!thinking && fenceMatch) {
      if (!fence) fence = fenceMatch;
      else if (fenceMatch[0] === fence[0] && fenceMatch.length >= fence.length) fence = undefined;
      output += line;
      continue;
    }
    if (fence) { output += line; continue; }
    if (!thinking && /^\s*<(?:think|thinking)>/u.test(line)) {
      thinking = true;
      line = line.replace(/^\s*<(?:think|thinking)>/u, "");
    }
    if (thinking) {
      const close = /<\/(?:think|thinking)>/u.exec(line);
      if (!close) continue;
      thinking = false;
      line = line.slice(close.index + close[0].length);
    } else if (/^\s*<\/(?:think|thinking)>(?:\s|$)/u.test(line)) {
      // 已观察到网关把答复放在孤立结束标签前、内部分析放在其后；该段余下内容不可公开。
      break;
    }
    const fragment = line.trim();
    if (fragment && !line.endsWith("\n") && ["<think>", "<thinking>", "</think>", "</thinking>"].some((tag) => tag.startsWith(fragment))) break;
    output += line;
  }
  return output;
}

const reasoningOpenTags = ["<think>", "<thinking>"];
const reasoningCloseTags = ["</think>", "</thinking>"];
const reasoningTags = [...reasoningOpenTags, ...reasoningCloseTags];
const notificationCloseTag = "</biny_notification>";
const maxStreamPrefix = 256;

type StreamLineMode = "prefix" | "text" | "fence-prefix" | "fence-run" | "thinking";

/**
 * Append-only streaming projection. Each source character is consumed once; only
 * an unfinished tag/line prefix is retained, never the accumulated response.
 *
 * The canonical projector is not monotone: whitespace preceding a later <think>
 * disappears, and a standalone closing tag is ambiguous until its next character.
 * We therefore withhold those prefixes. An exceptional >256-character ambiguous
 * prefix defers the rest of this step to finish(), bounding the streaming buffer.
 * finish receives the already-canonical step text (the caller still owns it).
 */
export class PublicAssistantStream {
  private mode: StreamLineMode = "prefix";
  private prefix = "";
  private allowEnvelope = true;
  private thinkingSuffix = "";
  private fence: { marker: string; length: number } | undefined;
  private fenceIndent = 0;
  private fenceRun = 0;
  private fenceMarker = "";
  private openingFence = false;
  private notification = false;
  private notificationSuffix = "";
  private publicNotificationSuffix = "";
  private stopped = false;
  private deferred = false;
  private finished = false;
  private emittedLength = 0;

  reset(): void {
    this.mode = "prefix";
    this.prefix = "";
    this.allowEnvelope = true;
    this.thinkingSuffix = "";
    this.fence = undefined;
    this.fenceIndent = 0;
    this.fenceRun = 0;
    this.fenceMarker = "";
    this.openingFence = false;
    this.notification = false;
    this.notificationSuffix = "";
    this.publicNotificationSuffix = "";
    this.stopped = false;
    this.deferred = false;
    this.finished = false;
    this.emittedLength = 0;
  }

  push(delta: string): string {
    if (this.finished) throw new Error("Reset the assistant stream before starting another message.");
    if (this.stopped || this.deferred) return "";
    const output: string[] = [];
    for (const character of delta) {
      this.consume(character, output);
      if (this.stopped || this.deferred) break;
    }
    const visible = output.join("");
    this.emittedLength += visible.length;
    return visible;
  }

  /** Flush safe ambiguity only against the completed canonical projection. */
  finish(canonical: string): string {
    if (this.finished) return "";
    this.finished = true;
    const remaining = canonical.slice(this.emittedLength);
    this.emittedLength = canonical.length;
    this.prefix = "";
    this.thinkingSuffix = "";
    this.notificationSuffix = "";
    this.publicNotificationSuffix = "";
    return remaining;
  }

  private consume(character: string, output: string[]): void {
    if (this.mode === "thinking") {
      this.thinkingSuffix += character;
      if (reasoningCloseTags.includes(this.thinkingSuffix)) {
        this.thinkingSuffix = "";
        this.mode = "prefix";
        // The canonical parser recognizes only one envelope per source line.
        this.allowEnvelope = false;
      } else {
        while (this.thinkingSuffix && !reasoningCloseTags.some((tag) => tag.startsWith(this.thinkingSuffix))) {
          this.thinkingSuffix = this.thinkingSuffix.slice(1);
        }
      }
      return;
    }
    if (this.mode === "fence-run") {
      if (character === this.fenceMarker) {
        this.fenceRun += 1;
        this.updateFence();
        this.publish(character, output);
        return;
      }
      this.mode = "text";
    }
    if (this.mode === "fence-prefix") {
      if (character === " " && this.fenceIndent < 3) {
        this.fenceIndent += 1;
        this.publish(character, output);
        return;
      }
      if (character === "`" || character === "~") {
        this.mode = "fence-run";
        this.fenceMarker = character;
        this.fenceRun = 1;
        this.openingFence = false;
        this.publish(character, output);
        return;
      }
      this.mode = "text";
    }
    if (this.mode === "text") {
      this.publish(character, output);
      if (character === "\n") this.startLine();
      return;
    }

    this.prefix += character;
    if (this.prefix.length > maxStreamPrefix) {
      // Arbitrary mixed whitespace cannot be losslessly retained in a fixed-size
      // suffix. The final canonical message will supply this rare deferred tail.
      this.prefix = "";
      this.deferred = true;
      return;
    }
    const fragment = this.prefix.trim();
    const closing = reasoningCloseTags.find((tag) => this.prefix.trimStart().startsWith(tag));
    if (this.allowEnvelope && closing && this.prefix.trimStart().length > closing.length
      && /\s/u.test(this.prefix.trimStart()[closing.length]!)) {
      this.prefix = "";
      this.stopped = true;
      return;
    }
    if (character === "\n") {
      this.publish(this.prefix, output);
      this.prefix = "";
      this.startLine();
      return;
    }
    if (this.allowEnvelope && reasoningOpenTags.includes(fragment) && character === ">") {
      this.prefix = "";
      this.mode = "thinking";
      return;
    }
    if (!fragment || reasoningTags.some((tag) => tag.startsWith(fragment))) return;
    if (this.allowEnvelope && /^ {0,3}[`~]$/u.test(this.prefix)) {
      this.mode = "fence-run";
      this.fenceMarker = character;
      this.fenceRun = 1;
      this.openingFence = true;
    } else {
      this.mode = "text";
    }
    this.publish(this.prefix, output);
    this.prefix = "";
  }

  private updateFence(): void {
    if (this.fenceRun < 3) return;
    if (this.openingFence) {
      this.fence = { marker: this.fenceMarker, length: this.fenceRun };
    } else if (this.fence?.marker === this.fenceMarker && this.fenceRun >= this.fence.length) {
      this.fence = undefined;
    }
  }

  private startLine(): void {
    this.mode = this.fence ? "fence-prefix" : "prefix";
    this.allowEnvelope = true;
    this.fenceIndent = 0;
  }

  /** Notification filtering follows reasoning filtering, including across removals. */
  private publish(text: string, output: string[]): void {
    for (const character of text) {
      const tag = this.notification ? notificationCloseTag : notificationOpenTag;
      this.notificationSuffix += character;
      if (this.notificationSuffix === tag) {
        this.notification = !this.notification;
        this.notificationSuffix = "";
        continue;
      }
      while (this.notificationSuffix && !tag.startsWith(this.notificationSuffix)) {
        if (!this.notification) this.publishNotificationCharacter(this.notificationSuffix[0]!, output);
        this.notificationSuffix = this.notificationSuffix.slice(1);
        if (this.stopped) return;
      }
    }
  }

  /**
   * Canonical block removal is followed by an unmatched-open/suffix guard.
   * Removing a block can join previously separate fragments into another tag;
   * that assembled tag must truncate the output, not be removed recursively.
   */
  private publishNotificationCharacter(character: string, output: string[]): void {
    this.publicNotificationSuffix += character;
    if (this.publicNotificationSuffix === notificationOpenTag) {
      this.publicNotificationSuffix = "";
      this.stopped = true;
      return;
    }
    while (this.publicNotificationSuffix && !notificationOpenTag.startsWith(this.publicNotificationSuffix)) {
      output.push(this.publicNotificationSuffix[0]!);
      this.publicNotificationSuffix = this.publicNotificationSuffix.slice(1);
    }
  }
}
