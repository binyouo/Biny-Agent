import { startTransition, useCallback, useEffect, useRef, useState } from "react";

/**
 * 平滑流式「打字机」——用于聊天正文的流式展示。
 *
 * 不是固定节拍逐字吐（那样会滞后、机械），而是：
 *  1. 用 requestAnimationFrame 以「字符速率（CPS）」驱动 reveal，小数累积取整，
 *     视觉上就是均匀连贯地往外流；
 *  2. reveal 速度跟随到达速度：取「最近 3s 到达速率」与「全程平均速率」的较小者
 *     （经 EMA 平滑），永不透支缓冲区 → 不会卡住等 token；
 *  3. 同时保证缓冲能撑过观测到的最大到达间隔（safeCps），网络抖动不断流；
 *  4. 流结束后把剩余缓冲按到达速率 1.25 倍收尾（封顶 90cps、4 秒内 flush 完）；
 *  5. 单块追加超过 500 字符（恢复会话/粘贴）或内容被整体替换时直接同步，不做动画。
 */

const DEFAULT_CPS = 50;
const MIN_CPS = 15;
const MAX_CPS = 300;
const MIN_FLUSH_CPS = 18;
const MAX_FLUSH_CPS = 90;
const FLUSH_SPEEDUP = 1.25;
const FLUSH_MAX_SECONDS = 4;
const EMA_ALPHA = 0.15;
const LARGE_APPEND = 500;
const ARRIVAL_WINDOW_MS = 3000;
const STALL_GAP_MS = 300;
const MAX_FRAME_DT_S = 0.1;
const MIN_COMMIT_INTERVAL_MS = 24;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 避免把 UTF-16 代理对（emoji 等）切成两半 */
function alignSliceEnd(text: string, end: number): number {
  if (end <= 0) return 0;
  if (end >= text.length) return text.length;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) return end + 1;
  return end;
}

export function useTypewriter(content: string, streaming: boolean): string {
  // 挂载即展示已有全文，只有「新增量」参与打字机动画
  const [displayed, setDisplayed] = useState(content);
  const displayedRef = useRef(content);
  const targetRef = useRef(content);
  const streamingRef = useRef(streaming);

  const emaCpsRef = useRef(DEFAULT_CPS);
  const lastInputTsRef = useRef(0);
  const lastInputCountRef = useRef(content.length);
  const streamStartTsRef = useRef(0);
  const streamStartCountRef = useRef(content.length);
  const arrivalLogRef = useRef<Array<{ t: number; c: number }>>([]);
  const maxGapMsRef = useRef(0);
  const stallCountRef = useRef(0);
  const charAccumRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastFrameTsRef = useRef<number | null>(null);
  const lastCommitTsRef = useRef(-Infinity);

  const syncImmediate = useCallback((text: string) => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastFrameTsRef.current = null;
    targetRef.current = text;
    displayedRef.current = text;
    charAccumRef.current = 0;
    setDisplayed(text);
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return;

    const tick = (ts: number) => {
      if (lastFrameTsRef.current === null) {
        lastFrameTsRef.current = ts;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const dt = clamp((ts - lastFrameTsRef.current) / 1000, 0, MAX_FRAME_DT_S);
      lastFrameTsRef.current = ts;

      const target = targetRef.current;
      const total = target.length;
      const cur = displayedRef.current.length;
      const backlog = total - cur;
      const isStreaming = streamingRef.current;

      if (backlog <= 0) {
        // 追平后由下一次内容变化唤醒，等待 token 时不持续占用帧回调。
        rafRef.current = null;
        lastFrameTsRef.current = null;
        charAccumRef.current = 0;
        return;
      }

      const nowMs = performance.now();

      let cps: number;
      if (!isStreaming) {
        // flush：流已结束，把剩余缓冲快速收尾
        let recentArrivalCps = DEFAULT_CPS;
        const log = arrivalLogRef.current;
        const first = log[0];
        if (log.length >= 2 && first) {
          const windowMs = nowMs - first.t;
          const windowChars = log.reduce((sum, a) => sum + a.c, 0);
          if (windowMs > 50) recentArrivalCps = (windowChars * 1000) / windowMs;
        }
        const natural = Math.max(MIN_FLUSH_CPS, recentArrivalCps * FLUSH_SPEEDUP);
        cps = clamp(Math.max(natural, backlog / FLUSH_MAX_SECONDS), MIN_FLUSH_CPS, MAX_FLUSH_CPS);
      } else {
        let arrivalCps: number;
        const log = arrivalLogRef.current;
        const first = log[0];
        if (log.length >= 2 && first) {
          const windowMs = nowMs - first.t;
          const windowChars = log.reduce((sum, a) => sum + a.c, 0);
          arrivalCps = windowMs > 50 ? (windowChars * 1000) / windowMs : MIN_CPS;
        } else {
          arrivalCps = MIN_CPS;
        }
        const streamElapsedS = streamStartTsRef.current > 0 ? (nowMs - streamStartTsRef.current) / 1000 : 0;
        const charsReceived = total - streamStartCountRef.current;
        const effectiveCps = streamElapsedS > 1 && charsReceived > 10 ? charsReceived / streamElapsedS : arrivalCps;

        const maxGapS = Math.max(0.5, maxGapMsRef.current / 1000);
        const safety = 1.5 + stallCountRef.current * 0.2;
        const safeCps = backlog / (maxGapS * safety);
        const arrivalCap = Math.min(arrivalCps, effectiveCps, emaCpsRef.current);
        cps = clamp(Math.min(safeCps, arrivalCap), MIN_CPS, MAX_CPS);
      }

      charAccumRef.current += cps * dt;
      if (ts - lastCommitTsRef.current < MIN_COMMIT_INTERVAL_MS) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const chars = Math.min(Math.floor(charAccumRef.current), backlog);
      if (chars < 1) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      charAccumRef.current -= chars;
      const nextCount = alignSliceEnd(target, Math.min(cur + chars, total));
      const next = displayedRef.current + target.slice(cur, nextCount);
      displayedRef.current = next;
      lastCommitTsRef.current = ts;
      // 正文解析可让位于输入、滚动等交互；字符预算仍按真实帧间隔累计。
      startTransition(() => setDisplayed(next));
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // 内容增长：登记到达速率并启动 reveal 循环
  useEffect(() => {
    const prev = targetRef.current;
    if (content === prev) return;

    if (!content.startsWith(prev)) {
      // 整体替换（分支切换/重置）：不同起点，直接同步
      arrivalLogRef.current = [];
      maxGapMsRef.current = 0;
      stallCountRef.current = 0;
      streamStartTsRef.current = 0;
      streamStartCountRef.current = content.length;
      lastInputTsRef.current = 0;
      lastInputCountRef.current = content.length;
      emaCpsRef.current = DEFAULT_CPS;
      syncImmediate(content);
      return;
    }

    const appended = content.length - prev.length;
    if (appended > LARGE_APPEND) {
      syncImmediate(content);
      return;
    }

    targetRef.current = content;
    const now = performance.now();
    if (lastInputTsRef.current > 0) {
      const gapMs = now - lastInputTsRef.current;
      if (gapMs > maxGapMsRef.current) maxGapMsRef.current = gapMs;
      if (gapMs > STALL_GAP_MS) stallCountRef.current += 1;
      const deltaChars = content.length - lastInputCountRef.current;
      const deltaMs = Math.max(1, now - lastInputTsRef.current);
      if (deltaChars > 0) {
        const instantCps = (deltaChars * 1000) / deltaMs;
        emaCpsRef.current = emaCpsRef.current * (1 - EMA_ALPHA) + clamp(instantCps, MIN_CPS, MAX_CPS * 2) * EMA_ALPHA;
      }
    }
    lastInputTsRef.current = now;
    lastInputCountRef.current = content.length;
    arrivalLogRef.current.push({ t: now, c: appended });
    const cutoff = now - ARRIVAL_WINDOW_MS;
    for (;;) {
      const first = arrivalLogRef.current[0];
      if (!first || first.t >= cutoff) break;
      arrivalLogRef.current.shift();
    }
    if (streamStartTsRef.current === 0) {
      streamStartTsRef.current = now;
      streamStartCountRef.current = content.length - appended;
    }
    startLoop();
  }, [content, startLoop, syncImmediate]);

  // streaming 标志同步给 rAF 循环；流结束但还有积压时立刻进入 flush
  useEffect(() => {
    streamingRef.current = streaming;
    if (!streaming && targetRef.current.length > displayedRef.current.length) {
      charAccumRef.current = 0;
      startLoop();
    }
  }, [streaming, startLoop]);

  // 卸载清理
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  return displayed;
}
