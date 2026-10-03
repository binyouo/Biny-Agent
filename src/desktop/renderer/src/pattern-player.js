/* global window, document, getComputedStyle, requestAnimationFrame, cancelAnimationFrame, ResizeObserver */
/* 此脚本作为文本放进 opaque iframe；不导入宿主模块，不访问宿主桥接。 */
(() => {
  const token = window.__patternPlayerToken;
  const button = document.querySelector("button");
  const icon = document.getElementById("play-icon");
  const canvas = document.querySelector("canvas");
  const alert = document.querySelector(".pattern-player-error");
  const api = window.strudel;
  let code = "";
  let state = "ready";
  let revision = 0;
  let initialization;
  let context;
  let analyser;
  let data;
  let animation;
  let busy = false;
  let evaluating = false;
  const smooth = new Float32Array(32);

  const publish = (next, message) => {
    state = next;
    button.disabled = busy || evaluating || !code;
    const playing = state === "playing";
    button.setAttribute("aria-label", playing ? "停止音乐" : "播放音乐");
    button.title = playing ? "停止音乐" : "播放音乐";
    button.classList.toggle("is-playing", playing);
    icon.setAttribute("d", playing ? "M6 6h12v12H6z" : "m8 5 11 7-11 7z");
    alert.hidden = !message;
    alert.textContent = message || "";
    window.parent.postMessage({ kind: "pattern-state", token, state, ...(message ? { message: String(message).slice(0, 512) } : {}) }, "*");
  };
  const draw = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width || 256);
    const height = Math.max(1, rect.height || 32);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (state === "playing" && analyser) analyser.getFloatFrequencyData(data);
    ctx.fillStyle = getComputedStyle(canvas).color;
    for (let i = 0; i < 32; i++) {
      const index = Math.floor(Math.pow(i / 32, 1.5) * Math.min(data?.length || 0, 256));
      const normalized = state === "playing" ? Math.max(0, Math.min(1, ((data?.[index] ?? -100) + 70) / 50)) : 0;
      smooth[i] += (normalized - smooth[i]) * .35;
      const barHeight = 2 + smooth[i] * Math.max(0, height - 4);
      ctx.globalAlpha = state === "playing" ? .5 + smooth[i] * .5 : .15;
      ctx.beginPath();
      ctx.roundRect(i * width / 32 + 1, height - barHeight, Math.max(.5, width / 32 - 2), barHeight, 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (state === "playing") animation = requestAnimationFrame(draw);
  };
  const release = () => {
    revision++;
    busy = false;
    cancelAnimationFrame(animation);
    animation = undefined;
    if (initialization) api?.hush();
    // 已销毁或已暂停的音频上下文不影响调度器已停止的事实。
    void context?.suspend().catch(() => {});
    smooth.fill(0);
  };
  const stop = () => { release(); publish("stopped"); draw(); };
  const fail = (error) => {
    release();
    publish("error", error instanceof Error ? error.message : String(error));
    draw();
  };
  const validatePattern = (pattern) => {
    for (const event of pattern.queryArc(0, 1)) {
      const controls = event.value;
      if (!controls || typeof controls !== "object" || !controls.s || ["-", "~", "_"].includes(controls.s)) continue;
      const sound = controls.bank ? `${controls.bank}_${controls.s}` : controls.s;
      const registered = api.getSound(sound);
      if (!registered || registered.data?.type === "sample") throw new Error(`当前播放器不支持外部样本 ${sound}；请选择内置合成器。`);
    }
    return pattern.analyze(1);
  };

  window.addEventListener("message", event => {
    const control = event.data;
    if (event.source !== window.parent || !control || typeof control !== "object" || Array.isArray(control)
      || control.kind !== "pattern-control" || control.token !== token) return;
    if (control.action === "stop" && Object.keys(control).every(key => ["kind", "token", "action"].includes(key))) stop();
    if (control.action !== "set-code" || Object.keys(control).some(key => !["kind", "token", "action", "code", "theme"].includes(key))
      || typeof control.code !== "string") return;
    if (control.code.length > 100000) { code = ""; fail("音乐代码过长，请缩短片段后重试。"); return; }
    stop();
    code = control.code;
    const theme = control.theme;
    if (theme && typeof theme === "object" && !Array.isArray(theme)) {
      document.documentElement.style.colorScheme = theme.mode === "dark" ? "dark" : "light";
      if (Number.isFinite(theme.fontScale) && theme.fontScale >= .5 && theme.fontScale <= 3) document.documentElement.style.setProperty("--font-scale", String(theme.fontScale));
      if (typeof theme.fontFamily === "string" && theme.fontFamily.length < 1000) document.documentElement.style.setProperty("--font-sans", theme.fontFamily);
      if (typeof theme.fontMono === "string" && theme.fontMono.length < 1000) document.documentElement.style.setProperty("--font-mono", theme.fontMono);
      if (theme.variables && typeof theme.variables === "object") {
        for (const [key, value] of Object.entries(theme.variables)) {
          if (/^--[a-z][a-z0-9-]{0,80}$/.test(key) && typeof value === "string" && value.length < 300) document.documentElement.style.setProperty(key, value);
        }
      }
    }
    publish("ready"); draw();
  });
  button.addEventListener("click", async () => {
    if (state === "playing") { stop(); return; }
    if (busy || evaluating || !code) return;
    busy = true;
    const requested = ++revision;
    publish("loading");
    try {
      if (!api?.initStrudel || !api.evaluate) throw new Error("音乐播放器加载失败。");
      api.setLogger?.(message => {
        if (typeof message === "string" && /\]\s*error:/i.test(message) && ["loading", "playing"].includes(state)) fail(message);
      });
      context = api.getAudioContext();
      // resume 在按钮事件中发起，键盘与触摸播放也保留用户激活。
      const resumed = context.resume();
      initialization ??= api.initStrudel({ sync: false, editPattern: validatePattern,
        onEvalError: error => { if (state === "loading") fail(error); },
        onUpdateState: next => { if (next.schedulerError && ["loading", "playing"].includes(state)) fail(next.schedulerError); }
      });
      const repl = await initialization;
      await resumed;
      if (requested !== revision) return;
      await api.initAudio();
      if (requested !== revision) return;
      let pattern;
      try { evaluating = true; pattern = await api.evaluate(code, false); }
      finally { evaluating = false; if (requested !== revision) button.disabled = !code; }
      if (requested !== revision) { api.hush(); return; }
      if (!pattern) throw new Error("音乐代码未产生可播放的片段。");
      analyser = api.getAnalyserById(1, 1024, .5);
      data = new Float32Array(analyser.frequencyBinCount);
      repl.start();
      busy = false;
      publish("playing"); draw();
    } catch (error) { if (requested === revision) fail(error); }
  });
  window.addEventListener("securitypolicyviolation", event => {
    if (event.violatedDirective === "connect-src") fail("当前播放器不支持下载外部音频样本；请选择内置合成器。");
  });
  window.addEventListener("unhandledrejection", event => { event.preventDefault(); fail(event.reason); });
  window.addEventListener("pagehide", release);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  new ResizeObserver(draw).observe(canvas);
  publish("ready"); draw();
})();
