/**
 * 回复朗读。
 *
 * 直接用 Chromium 内置的 SpeechSynthesis（macOS 上就是系统语音），不额外引 TTS 依赖和模型文件。
 * 同一时刻只朗读一段：新的朗读会打断上一段，并回调上一段的 `onDone`，让旧按钮复位成「朗读」。
 *
 * `speak` 返回的停止函数只停「自己这一段」——别的消息接手之后再调用它是空操作。旧组件卸载时
 * 的清理会晚于新朗读开始，不做这层判断就会把刚开始的朗读掐掉。
 */

/** 当前这段朗读的收尾回调，同时用作「谁在朗读」的标识。 */
let finishActive: (() => void) | undefined;

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function speak(text: string, onDone: () => void): () => void {
  stop();
  const utterance = new SpeechSynthesisUtterance(text);
  // 中英文用不同的系统语音，选错了中文会被逐字母念出来。
  utterance.lang = /[一-鿿]/.test(text) ? "zh-CN" : "en-US";
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (finishActive === finish) finishActive = undefined;
    onDone();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  finishActive = finish;
  window.speechSynthesis.speak(utterance);
  return () => {
    if (finishActive === finish) stop();
  };
}

function stop(): void {
  const finish = finishActive;
  finishActive = undefined;
  window.speechSynthesis.cancel();
  finish?.();
}
