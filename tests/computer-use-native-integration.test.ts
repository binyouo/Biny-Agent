import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

// UI 复刻的判据：设置页展示的数据必须真的来自原生 daemon。
// 这里直接跑真 daemon，验证喂给渲染层的形状与内容。
test("native daemon feeds the settings surface with live diagnostics", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const reply = await driver.diagnostics();
    const data = reply.data as { accessibility?: string; screenRecording?: string; version?: string; uptime?: number };
    assert.equal(typeof data.version, "string", "doctor must report a version for the helper row");
    assert.equal(typeof data.uptime, "number", "doctor must report uptime for the helper row");
    assert.ok(["granted", "denied"].includes(data.accessibility ?? ""), "accessibility state drives the permission grid");
    assert.ok(["granted", "denied"].includes(data.screenRecording ?? ""), "screen recording state drives the permission grid");

    const list = await driver.list("settings-e2e", undefined);
    const apps = (list.data as { apps?: { name: string; running: boolean }[] }).apps ?? [];
    assert.ok(apps.length > 0, "settings app list must render at least one running app");
    assert.ok(apps.every(app => typeof app.name === "string" && app.name.length > 0), "every app row needs a label");
  } finally {
    await driver.dispose();
  }
});

// PiP 的 3fps 帧泵靠 reply.images；截图必须从 daemon 的落盘路径读回来。
test("observe returns a decodable frame so the preview pump has something to paint", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("pip-e2e", undefined);
    const apps = (listed.data as { apps?: { name: string; pid: number }[] }).apps ?? [];
    assert.ok(apps.length > 0, "need at least one running app to observe");
    const reply = await driver.observe("pip-e2e", { pid: apps[0].pid } as never);
    const images = reply.images ?? [];
    assert.equal(images.length, 1, "observe must hand back exactly one frame for the preview window");
    const frame = images[0] as { mimeType: string; dataBase64: string };
    assert.equal(frame.mimeType, "image/jpeg");
    // JPEG 以 FFD8FF 开头；base64 前缀必须是 /9j/。
    assert.ok(frame.dataBase64.startsWith("/9j/"), "frame must be a real jpeg, not a placeholder");
  } finally {
    await driver.dispose();
  }
});

// set_value 直写 AX，不模拟按键：写完必须能从无障碍树上读回来。
test("set_value writes through the accessibility API and reads back", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("value-e2e", undefined);
    const apps = (listed.data as { apps?: { name: string; pid: number }[] }).apps ?? [];
    const target = apps.find(app => /TextEdit|文本编辑/i.test(app.name));
    if (!target) return; // 文本编辑没开就跳过，不伪造通过
    const snapshot = await driver.observe("value-e2e", { pid: target.pid } as never);
    const elements = (snapshot.data as { elements?: { element_token?: string; role?: string; value?: string }[] }).elements ?? [];
    const area = elements.find(element => element.role === "AXTextArea");
    assert.ok(area?.element_token, "需要一个可编辑文本区");

    const marker = `ax-write-${Date.now()}`;
    const written = await driver.actRaw("set_value", { ref: area.element_token, value: marker });
    assert.ok(!written.errorCode, `set_value 不应报错：${written.errorCode ?? ""}`);

    const after = await driver.observe("value-e2e", { pid: target.pid } as never);
    const reread = ((after.data as { elements?: { role?: string; value?: string }[] }).elements ?? [])
      .find(element => element.role === "AXTextArea")?.value;
    assert.equal(reread, marker, "写进去的值必须能从 AX 树读回来");
  } finally {
    await driver.dispose();
  }
});

// 产品内工具的动作面必须真能驱动 daemon 的全部动词，而不只是 schema 允许。
test("the in-product act path reaches the verbs beyond the original four", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("act-e2e", undefined);
    const apps = (listed.data as { apps?: { name: string; pid: number }[] }).apps ?? [];
    const target = apps.find(app => /TextEdit|文本编辑/i.test(app.name));
    if (!target) return; // 没开就跳过，不伪造通过

    const snapshot = await driver.observe("act-e2e", { pid: target.pid } as never);
    const elements = (snapshot.data as { elements?: { element_token?: string; role?: string; value?: string }[] }).elements ?? [];
    const area = elements.find(element => element.role === "AXTextArea");
    assert.ok(area?.element_token, "需要一个可编辑文本区");

    // 走 act()（产品内路径），不是 actRaw。
    const marker = `act-set-${Date.now()}`;
    const written = await driver.act("act-e2e", { action: "set_value", elementToken: area.element_token, value: marker } as never);
    assert.ok(!written.errorCode, `act(set_value) 不应报错：${written.errorCode ?? ""}`);

    const after = await driver.observe("act-e2e", { pid: target.pid } as never);
    const reread = ((after.data as { elements?: { role?: string; value?: string }[] }).elements ?? [])
      .find(element => element.role === "AXTextArea")?.value;
    assert.equal(reread, marker, "产品内动作写进去的值必须能从 AX 树读回来");
  } finally {
    await driver.dispose();
  }
});

// driver 与服务端解析的是 daemon 的返回形状。这个契约已经错过两次
// （嵌套 permissions、空 bundleId），所以把每条命令的形状一次钉住。
test("every daemon command answers in the shape its caller parses", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    // doctor：服务端读扁平的 accessibility / screenRecording + version / uptime / focusGuard
    const doctor = (await driver.diagnostics()).data as Record<string, unknown>;
    for (const key of ["accessibility", "screenRecording", "version", "uptime", "focusGuard"]) {
      assert.ok(key in doctor, `doctor 必须给出 ${key}`);
    }

    // list_apps：运行中的 {pid,name,running,bundleId}（bundleId 可选且不得为空串），
    // 加上近 N 天用过但没在运行的 {name,running:false,lastUsed,bundleId} —— 后者是
    // launch_app 的候选集，没有 pid 是对的。
    const apps = ((await driver.list("contract", undefined)).data.apps ?? []) as { pid?: unknown; name?: unknown; running?: unknown; bundleId?: unknown; lastUsed?: unknown }[];
    assert.ok(apps.some(app => app.running === true), "至少要有一个运行中的应用");
    for (const app of apps) {
      assert.equal(typeof app.name, "string");
      assert.equal(typeof app.running, "boolean");
      if ("bundleId" in app) assert.ok(typeof app.bundleId === "string" && app.bundleId.length > 0, "bundleId 要么缺席，要么非空——空串会让整份列表解析失败");
      if (app.running === true) assert.equal(typeof app.pid, "number", "运行中的必须有 pid");
      else assert.equal(app.pid, undefined, "没在运行的不该有 pid");
    }

    const target = apps.find(app => /TextEdit|文本编辑/i.test(String(app.name)));
    if (!target) return;

    // observe：captureSchema 要的字段 + 一张可解码的图
    const observation = await driver.observe("contract", { pid: target.pid as number } as never);
    const capture = observation.data as Record<string, unknown>;
    for (const key of ["pid", "window_id", "capture_id", "screenshot_width", "screenshot_height", "screenshot_frame_valid", "elements"]) {
      assert.ok(key in capture, `observe 必须给出 ${key}`);
    }
    assert.equal(capture.screenshot_frame_valid, true);

    const element = ((capture.elements ?? []) as { element_token?: string; role?: string }[])[0];
    assert.ok(element?.element_token, "元素必须带可引用的 token");

    // 值/文本类动作必须落在可编辑元素上：对窗口节点写值本来就该失败，
    // 拿它当断言目标只会测出「正确拒绝」，测不出契约。
    const editable = ((capture.elements ?? []) as { element_token?: string; role?: string }[])
      .find(entry => entry.role === "AXTextArea" || entry.role === "AXTextField");

    // 动作类：每个动词都要回一个可读的确认，而不是空对象
    const acts: [string, Record<string, unknown>][] = [
      ["click", { elementToken: element.element_token }],
      ["press_key", { key: "Return" }],
      ["drag", { x1: 200, y1: 300, x2: 220, y2: 300 }],
      ["perform_secondary_action", { elementToken: element.element_token }]
    ];
    if (editable?.element_token) {
      acts.push(
        ["type_text", { elementToken: editable.element_token, text: "c" }],
        ["scroll", { elementToken: editable.element_token, direction: "down", amount: 1 }],
        ["set_value", { elementToken: editable.element_token, value: "contract" }],
        ["select_text", { elementToken: editable.element_token, location: 0, length: 0 }]
      );
    }
    for (const [action, extra] of acts) {
      const reply = await driver.act("contract", { action, ...extra } as never);
      assert.ok(!reply.errorCode, `${action} 不应报错：${reply.errorCode ?? ""}`);
      assert.ok(Object.keys(reply.data).length > 0, `${action} 必须回一个确认体`);
    }

    // grant：必须能从守护进程侧发起 —— 系统弹窗授的是发起进程，
    // 从宿主发起会把辅助功能授给宿主而不是 helper（用户授完仍然用不了）。
    const grant = (await driver.grantAccessibility()).data as Record<string, unknown>;
    assert.ok(["granted", "denied"].includes(grant.accessibility as string), "grant 必须回报辅助功能状态");
    assert.equal(typeof grant.prompted, "boolean");

    // launch_app / capture_screen
    const launched = await driver.launchApp("com.apple.TextEdit");
    assert.equal(typeof (launched.data as { pid?: unknown }).pid, "number");
    assert.equal(((await driver.captureScreen()).images ?? []).length, 1);
  } finally {
    await driver.dispose();
  }
});

// 最坏的一类失败是"报成功但没写进去"。守护进程必须能识别出这种情形并说出来，
// 而不是回一个 typed=N 让人以为成了（notes/19 §3 的做法）。
test("type_text says so when the keystrokes were probably dropped", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("warn-e2e", undefined);
    const apps = (listed.data as { apps?: { name: string; pid: number; running?: boolean }[] }).apps ?? [];
    // 找一个在后台、且没有聚焦 UI 元素的目标 —— 按键在那种状态会被系统丢掉。
    // 找不到就跳过：不伪造一个必然成立的场景。
    let warned: string | undefined;
    for (const app of apps.slice(0, 8)) {
      const observed = await driver.observe("warn-e2e", { pid: app.pid } as never).catch(() => undefined);
      if (!observed) continue;
      const reply = await driver.actRaw("type_text", { text: "x", pid: app.pid });
      const data = reply.data as { typed?: number; warning?: string };
      if (data.warning) { warned = data.warning; break; }
    }
    if (!warned) return;
    assert.match(warned, /keystrokes_may_be_dropped/, "警告要带可判别的错误码");
    assert.match(warned, /重新观察|别把它当成写进去了/, "警告要给出下一步，而不只是说坏了");
  } finally {
    await driver.dispose();
  }
});

// 三处与参照实现的偏差，都是便宜且该对齐的：
// 截图统一 1280 宽、元素带 focused、点击依次试三种 AX 动作。
test("the daemon matches the reference on screenshot width, focus reporting and click actions", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("align-e2e", undefined);
    const apps = (listed.data as { apps?: { name: string; pid: number }[] }).apps ?? [];
    const target = apps.find(app => /TextEdit|文本编辑/i.test(app.name)) ?? apps[0];
    const observed = await driver.observe("align-e2e", { pid: target.pid } as never);
    const data = observed.data as { screenshot_width?: number; elements?: { element_token?: string; role?: string; focused?: boolean }[] };

    // 截图宽度统一到 1280：再宽只是白烧带宽和上下文
    assert.equal(data.screenshot_width, 1280, "截图宽度应与参照一致");

    // focused 是可读属性（本例可能是 0 个聚焦元素，但字段必须能被读出来）
    const elements = data.elements ?? [];
    assert.ok(elements.every(entry => entry.focused === undefined || entry.focused === true), "focused 只在该元素确实聚焦时出现");

    // 点击要走通（AXPress → AXPick → AXConfirm → 物理点击）
    const area = elements.find(entry => entry.role === "AXTextArea" || entry.role === "AXButton");
    if (area?.element_token) {
      const clicked = await driver.act("align-e2e", { action: "click", elementToken: area.element_token } as never);
      assert.ok(!clicked.errorCode, `点击不应报错：${clicked.errorCode ?? ""}`);
    }
  } finally {
    await driver.dispose();
  }
});

// socket 名按二进制内容隔离，不按工作目录：同一个 daemon 不该因为用户
// 从不同目录启动就成了两个（两份 ref 表、两套空闲计时）。
test("the daemon socket is keyed by the binary, not the working directory", () => {
  const binary = new URL("../out/native/computer-use", import.meta.url).pathname;
  const socketOf = () => (new NativeProcessDriver(() => {}, { binaryPath: binary }) as unknown as { socketPath: string }).socketPath;

  const original = process.cwd();
  const first = socketOf();
  try {
    process.chdir("/tmp");
    assert.equal(socketOf(), first, "换目录不该换 socket —— 否则会起第二个 daemon");
  } finally {
    process.chdir(original);
  }

  assert.match(first, /Application Support\/alma\/biny-computer-use-[0-9a-f]{8}\.sock$/);
  // 内容哈希：二进制变了名字就得变，旧构建的 daemon 不能应答新请求
  const other = new NativeProcessDriver(() => {}, { binaryPath: "/bin/echo" }) as unknown as { socketPath: string };
  assert.notEqual(other.socketPath, first);
});

// list_apps 只有运行中的应用时，模型看不到这台机器上**还有什么可以 launch** ——
// 而 launch_app 要的正是 bundle id。运行中 + 近 N 天用过的才是完整的候选集。
test("list_apps offers apps that are not running, because those are the ones to launch", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const reply = await driver.list("apps-e2e", undefined);
    const apps = (reply.data as { apps: { name: string; bundleId?: string; pid?: number; running?: boolean; lastUsed?: string }[] }).apps;

    assert.ok(apps.length > 0);
    // 每条都要有可 launch 的标识：光有名字没法传给 launch_app
    for (const app of apps) assert.ok(app.bundleId, `${app.name} 缺 bundleId，launch_app 用不了`);
    // 同一个应用不该出现两次（运行中的那份带 pid，优先）
    assert.equal(new Set(apps.map(app => app.bundleId)).size, apps.length, "bundleId 不能重复");

    for (const app of apps.filter(entry => entry.running)) assert.equal(typeof app.pid, "number");
    for (const app of apps.filter(entry => !entry.running)) {
      assert.equal(app.pid, undefined, "没在运行的不该有 pid");
      assert.match(app.lastUsed ?? "", /^\d{4}-\d{2}-\d{2}T/, "没在运行的要带最后使用时间");
    }
  } finally {
    await driver.dispose();
  }
});

// ComputerObserve 把 windowId 列为必填，但以前没有任何命令能产出它，守护进程也从不读它
// —— 模型只能编一个字符串，而真正拍哪个窗口由守护进程自己决定。
// 这条链上有四个参数被吞掉，任何一环断掉都会退回到「随便拍一个」。
test("a window id can be discovered, requested, and comes back as the window captured", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("win-e2e", undefined);
    const apps = (listed.data as { apps: { name: string; pid?: number }[] }).apps;
    const target = apps.find(app => typeof app.pid === "number");
    assert.ok(target?.pid, "至少要有一个运行中的应用");

    // 给了 pid 就要给窗口，而不是把整份应用列表再吐一遍
    const scoped = await driver.list("win-e2e", target.pid);
    const windows = (scoped.data as { apps: { windows?: { window_id: number; frame: { w: number } }[] }[] }).apps[0]?.windows ?? [];
    for (const window of windows) assert.ok(Number.isInteger(window.window_id) && window.window_id > 0, "窗口号必须是真编号");

    if (windows.length === 0) return;   // 这个应用当时没有在屏窗口，不伪造场景

    // 请求哪个窗口，就得回报哪个窗口
    for (const window of windows) {
      const observed = await driver.observe("win-e2e", { pid: target.pid!, windowId: String(window.window_id) } as never);
      const data = observed.data as { window_id?: number };
      assert.equal(data.window_id, window.window_id, `指定的窗口没有被真正使用（请求 ${window.window_id}，回报 ${data.window_id}）`);
    }

    // 不指定时也要回报一个真窗口号，而不是拿 pid 冒充
    const fallback = await driver.observe("win-e2e", { pid: target.pid! } as never);
    const fallbackId = (fallback.data as { window_id?: number }).window_id;
    assert.ok(Number.isInteger(fallbackId) && fallbackId! > 0);
    assert.notEqual(fallbackId, target.pid, "windowId 不能是 pid 冒充的");
  } finally {
    await driver.dispose();
  }
});

// notes/31 的 cu 里，status / raise / shutdown 是**命令行层**的动词（不在模型的 13 个工具里）。
// status 回答「helper 包在不在、守护进程还能活多久」；raise 是唯一允许动焦点的动词，
// 所以它必须显式，且失败时要说明为什么 —— 别的动作永远不许把应用提到前面。
test("the daemon answers status, and raise reports honestly when it cannot come forward", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  const call = (cmd: string, args: Record<string, unknown> = {}) =>
    (driver as unknown as { call: (c: string, a: unknown) => Promise<{ data: Record<string, unknown> }> }).call(cmd, args);
  try {
    const status = (await call("status")).data;
    assert.equal(typeof status.helperPresent, "boolean");
    assert.equal(typeof status.uptimeSeconds, "number");
    assert.ok(Number(status.idleSeconds) > 0, "要能看出还剩多久自退");
    assert.ok(String(status.socket).endsWith(".sock"));

    const listed = await driver.list("raise-e2e", undefined);
    const target = (listed.data as { apps: { pid?: number }[] }).apps.find(app => typeof app.pid === "number");
    if (target?.pid) {
      // 不存在的窗口号：要么提到应用、要么说清为什么没提到，但不能静默成功
      const raised = (await call("raise", { pid: target.pid, window_id: 99999999 })).data;
      assert.equal(raised.raised, target.pid);
      assert.match(String(raised.warning ?? ""), /window_not_found/, "没找到窗口就要说，别让调用方以为提上来了");
    }
  } finally {
    await driver.dispose();
  }
});

// 第二个调用方要用得上第一个观察到的 ref。
// socket 名按二进制隔离，用意就是「同一个 daemon 被所有调用方共用」——
// 如果每个调用方都 spawn 一个（新 daemon 会 unlink 并重绑 socket，把前一个顶掉），
// 或者走完就把它杀掉，ref 表就永远活不过一次调用，`cu snap` 的 ref 在下一条命令里必然失效。
test("a second driver shares the running daemon, so refs outlive the call that made them", async () => {
  const binaryPath = new URL("../out/native/computer-use", import.meta.url).pathname;
  const first = new NativeProcessDriver(() => {}, { binaryPath });
  const second = new NativeProcessDriver(() => {}, { binaryPath });
  try {
    const listed = await first.list("share-a", undefined);
    const target = (listed.data as { apps: { pid?: number; windowId?: number }[] }).apps.find(app => typeof app.pid === "number");
    assert.ok(target?.pid, "至少要有一个运行中的应用");

    const observed = await first.daemonCommand("get_app_state", { pid: target.pid, max_elements: 0 });
    const elements = (observed.data as { elements?: { element_token?: string }[] }).elements ?? [];
    const ref = elements.find(element => element.element_token)?.element_token;
    if (!ref) return;  // 这个应用当时没有可引用的元素，不伪造场景

    // 第二个实例读第一个实例刚观察到的 ref —— 共用同一个 daemon 才可能成立。
    // 故意给一个不存在的按键名：如果 ref 没被认出来，报错会是 element_ref_not_observed，
    // 而这里期望的报错是按键名不认识 —— 那才能证明它越过了 ref 查找。
    await assert.rejects(
      () => second.daemonCommand("press", { pid: target.pid, ref, key: "NoSuchKey" }),
      error => /unknown_press_key/.test(String(error)) && !/element_ref_not_observed/.test(String(error))
    );
  } finally {
    await first.dispose().catch(() => undefined);
    await second.dispose().catch(() => undefined);
  }
});

// 鼠标事件不能走 postToPid：投给进程的鼠标事件到不了窗口，而 API 照样返回成功。
// 实测（TextEdit 双击选词）postToPid → 选区纹丝不动；全局 post → 选中 8 个字符。
// 这条测试钉住「次数与按键被如实回报」，实际落地在真机上验证过。
test("a pixel click reports the button and the number of clicks it dispatched", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("click-e2e", undefined);
    const apps = (listed.data as { apps: { pid?: number }[] }).apps;
    const target = apps.find(app => typeof app.pid === "number");
    if (!target?.pid) return;
    // 点在自己窗口的左上角区域之外没有意义，这里只验证回执与所发的一致
    const observed = await driver.observe("click-e2e", { pid: target.pid } as never);
    const frame = (observed.data as { elements?: { role?: string; frame?: { x: number; y: number } }[] }).elements?.find(e => e.frame)?.frame;
    if (!frame) return;
    const x = frame.x + 5, y = frame.y + 5;
    const single = await driver.actRaw("click", { pid: target.pid, x, y, coord_space: "screen", clicks: 1 });
    assert.equal((single.data as { clicks?: number }).clicks, 1);
    const double = await driver.actRaw("click", { pid: target.pid, x, y, coord_space: "screen", clicks: 2, button: "left" });
    assert.equal((double.data as { clicks?: number }).clicks, 2, "双击要如实回报 2 —— 它靠 clickState 序列实现，不是发两次单击");
  } finally {
    await driver.dispose();
  }
});

// --no-shot：只读树。截图要过一次 ScreenCaptureKit，纯读结构时那是白付的等待
// （实测同一窗口 1338ms → 665ms）。但树必须照常回来。
test("no_shot skips the capture and still returns the tree", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    // 必须挑**有窗口**的应用：随便拿第一个有 pid 的，它可能压根没有窗口，
    // 那样树本来就是空的，测试会变成看运气（这条一开始就犯了这个错）。
    const listed = await driver.list("noshot-e2e", undefined);
    const apps = (listed.data as { apps: { pid?: number }[] }).apps;
    let target: { pid?: number } | undefined;
    for (const app of apps) {
      if (typeof app.pid !== "number") continue;
      const scoped = await driver.list("noshot-e2e", app.pid);
      const windows = (scoped.data as { apps: { windows?: unknown[] }[] }).apps[0]?.windows ?? [];
      if (windows.length) { target = app; break; }
    }
    if (!target?.pid) return;

    const full = await driver.daemonCommand("get_app_state", { pid: target.pid, max_elements: 40 });
    const lean = await driver.daemonCommand("get_app_state", { pid: target.pid, max_elements: 40, no_shot: true });
    const fullData = full.data as { elements?: unknown[] };
    const leanData = lean.data as { elements?: unknown[] };

    // 截图在 shape 之后落在 images 里，不在 data 上 —— 别去 data.screenshot 找。
    assert.ok(full.images.length > 0, "默认要截图");
    assert.equal(lean.images.length, 0, "no_shot 不该有截图");
    assert.ok((leanData.elements?.length ?? 0) > 0, "树照常要回来");
    assert.equal(leanData.elements?.length, fullData.elements?.length, "跳截图不该改变读到的结构");
  } finally {
    await driver.dispose();
  }
});

// 两条路由是两种机制：AX 让控件执行它自己的动作（不碰坐标），物理点击合成鼠标事件
// （能表达双击和右键，但依赖坐标与前台）。strategy 让调用方指定，而 auto 必须如实
// 回报**实际走了哪条** —— 以前它无论怎么走都写 route:"ax"，那是个小谎。
test("click honours the strategy it was given, and refuses the impossible combinations", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("strategy-e2e", undefined);
    const apps = (listed.data as { apps: { pid?: number }[] }).apps;
    const target = apps.find(app => typeof app.pid === "number");
    if (!target?.pid) return;
    const observed = await driver.observe("strategy-e2e", { pid: target.pid } as never);
    const elements = (observed.data as { elements?: { element_token?: string; role?: string; frame?: unknown }[] }).elements ?? [];
    const ref = elements.find(element => element.element_token && element.frame)?.element_token;
    if (!ref) return;

    // 坐标 + strategy=ax：AX 是按元素动作的，坐标对它没有意义 —— 说清楚，别假装能走
    await assert.rejects(
      () => driver.actRaw("click", { pid: target.pid, x: 10, y: 10, strategy: "ax" }),
      /strategy_ax_needs_ref/
    );

    // AX 只有单次左键动作，表达不了双击 —— 也别说能做
    await assert.rejects(
      () => driver.actRaw("click", { pid: target.pid, ref, strategy: "ax", clicks: 2 }),
      /ax_cannot_express_this_click/
    );

    // physical 一定走物理：它不需要控件支持任何 AX 动作
    const physical = await driver.actRaw("click", { pid: target.pid, ref, strategy: "physical" });
    assert.equal((physical.data as { route?: string }).route, "physical");

    // auto 要如实说走了哪条，而不是一律写 ax
    const auto = await driver.actRaw("click", { pid: target.pid, ref, clicks: 2 });
    assert.equal((auto.data as { route?: string }).route, "physical", "双击 AX 表达不了，auto 应当退到物理并如实回报");
  } finally {
    await driver.dispose();
  }
});

// lens 是动作指示器：让用户看见 agent 在哪里动手（参照实现的 helper 里是 Overlay.swift，
// 含 LensOverlay/ActionCursor 与 scrollBadge/typeBadge 两个角标）。开关状态必须如实回报，
// 因为它同时决定「用户会不会看到这次动作」。
// 可见性在真机上单独验证过：off 与 show_cursor=false 都不出现，默认出现且**不吃点击**
// （全屏覆盖时双击仍能选中词）。
test("lens reports its state and toggles", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const on = (await driver.daemonCommand("lens", { mode: "on" })).data as { enabled?: boolean };
    assert.equal(on.enabled, true);
    const off = (await driver.daemonCommand("lens", { mode: "off" })).data as { enabled?: boolean };
    assert.equal(off.enabled, false);
    const toggled = (await driver.daemonCommand("lens", { mode: "toggle" })).data as { enabled?: boolean };
    assert.equal(toggled.enabled, true, "从关到开");
    const back = (await driver.daemonCommand("lens", { mode: "toggle" })).data as { enabled?: boolean };
    assert.equal(back.enabled, false, "再 toggle 应翻回");
    await driver.daemonCommand("lens", { mode: "on" });
  } finally {
    await driver.dispose();
  }
});

// 一页 = 视口/内容，**量出来的**而不是估的：滚动区的子元素里最大的那个就是内容。
// 活动监视器实测 AXOutline 高 13836、视口 472 → 一页 3.45%，滚一页后滚动条真的移动 3.405%。
// （上一版这里是个约定值「一格 = 10%」，因为当时以为滑块尺寸读不到就算不出一页。）
test("a page is the real viewport/content ratio, and scrolling one page moves that far", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  const position = async (pid: number): Promise<number> =>
    ((await driver.daemonCommand("scroll", { pid, direction: "down", pages: 0 })).data as { from?: number }).from ?? -1;
  try {
    const listed = await driver.list("page-e2e", undefined);
    const apps = (listed.data as { apps: { pid?: number }[] }).apps;
    // 需要一个内容比视口高的滚动区；找不到就不伪造场景
    for (const app of apps) {
      if (typeof app.pid !== "number") continue;
      const warm = await driver.daemonCommand("scroll", { pid: app.pid, direction: "down", pages: 1 });
      const data = warm.data as { route?: string; unit?: string; fraction?: number };
      if (data.route !== "ax" || data.unit !== "pages") continue;

      const fraction = data.fraction ?? 0;
      assert.ok(fraction > 0 && fraction < 0.5, `一页应当是范围的一小部分，实测 ${fraction}`);
      const before = await position(app.pid);
      await driver.daemonCommand("scroll", { pid: app.pid, direction: "down", pages: 1 });
      const after = await position(app.pid);
      // 到底就测不到位移，那就只验回执的 fraction 与之一致
      if (after <= before) return;
      assert.ok(Math.abs((after - before) - fraction) < fraction * 0.25,
        `滚一页应移动一个 fraction：回执 ${fraction.toFixed(4)}，实测 ${(after - before).toFixed(4)}`);
      return;
    }
  } finally {
    await driver.dispose();
  }
});

// 第一层（事前拦截，参照的 FocusStealPreventer）建在 CGEventTapCreateForPid 上。
// 本实现的 doctor 会分开报「按 pid 的 tap」和「全会话的 tap」—— 两者的失败原因不同，
// 合成一个 available/unavailable 会把「权限没给」和「这个 API 在这儿用不了」混成一件事。
test("doctor distinguishes a per-pid event tap from a session one", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const doc = (await driver.daemonCommand("doctor")).data as { accessibility?: string; focusTap?: string };
    assert.equal(doc.accessibility, "granted", "本用例需要辅助功能权限");
    // 取值是三次采样的**模式**：per-pid / session-only / intermittent(per-pid n/3) / none。
    // 只断言"这个字段可判别"，**不断言某一次一定能建起来** ——
    // 实测同一台机器上它会飘（2/3、3/3 都出现过），断言具体值只会让测试随机失败。
    assert.match(doc.focusTap ?? "", /^(per-pid|session-only|intermittent\(per-pid \d\/3\)|none)$/, `focusTap 取值应可判别：${doc.focusTap ?? "缺失"}`);
  } finally {
    await driver.dispose();
  }
});

// 原生意图（参照叫 "Layer 1 app-command dispatch"）：对认识的应用不驱动 UI，
// 直接把意图走 URL scheme 派给应用。参照的 URL 模板从它的 helper 二进制里读出来的。
// 这里只测**不产生副作用的分支** —— 真派发会开标签页/切页面，不该进测试套件。
test("intent refuses unknown names and URLs with no handler", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    // 不认识的意图要列出可用的几个，别只说"不行"
    await assert.rejects(
      () => driver.daemonCommand("intent", { intent: "no_such_intent" }),
      // 文案从 unknown_intent_or_url 拆成了 unknown_intent —— 名字不认识、
      // 名字对但没给 url、url 不合法、没装处理者，四种要分开报。
      error => /unknown_intent/.test(String(error)) && /play_song/.test(String(error)),
      "未知意图应当把可用项列出来"
    );
    // 系统里没有处理者的 scheme：要在这儿就失败，而不是"派了但没人接"
    await assert.rejects(
      () => driver.daemonCommand("intent", { intent: "open_url", url: "binycu-nonexistent-scheme://x" }),
      /intent_no_handler/
    );
  } finally {
    await driver.dispose();
  }
});

// 参照的 get_app_state 会自动后台拉起未运行的应用（"auto-launches the target app in the
// background if it is not running"），本实现已对齐。这里只测**不产生副作用的分支** ——
// 真去拉起一个应用会往用户屏幕上开窗口，不该进测试套件。
test("observing an unknown bundle fails as not-installed rather than not-found", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    // 装都没装：要在这一步就说清楚，而不是去尝试拉起然后超时
    await assert.rejects(
      () => driver.daemonCommand("get_app_state", { bundle: "com.biny.definitely-not-installed", max_elements: 5 }),
      /app_not_installed/
    );
  } finally {
    await driver.dispose();
  }
});

// Appshot 是参照里一条面向用户的通路：设置一个全局热键，按下抓当前前台应用。
// 这里只测**无副作用的分支** —— 真去抓会写文件、真去装热键会挂全局 tap。
test("appshot reports the frontmost app and refuses a malformed hotkey", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    // 前台识别：要能排除自己（参照的 appshot_frontmost 同样带 exclude）
    const front = (await driver.daemonCommand("appshot_frontmost")).data as { pid?: number; bundleId?: string };
    assert.ok(Number.isInteger(front.pid) && front.pid! > 0, "应当报出前台应用的 pid");
    assert.notEqual(front.bundleId, "com.biny.computer-use", "不该把自己当前台");

    // 热键写法不对要在装之前就说清楚，而不是装上一个永远不触发的
    await assert.rejects(
      () => driver.daemonCommand("appshot_monitor_start", { hotkey: "Ctrl+NotAKey" }),
      /invalid_hotkey/
    );

    // 状态里必须能看出「装了但不收事件」—— 这个环境里 tap 建得起来却不投递
    const status = (await driver.daemonCommand("appshot_status")).data as { armed?: boolean; live?: boolean; eventsSeen?: number };
    assert.equal(typeof status.armed, "boolean");
    assert.equal(typeof status.eventsSeen, "number", "要把收到的事件数暴露出来，否则『装了没反应』无从判断");
  } finally {
    await driver.dispose();
  }
});

// Appshot 热键：装了要真的能被按键触发。
// 触发方式用 daemon 自己的**全局**派发（`press_key … global: true`）——
// 外部探针的全局投递在这台机器上不生效（CGPreflightPostEventAccess 报"允许"但事件没出去），
// 用坏掉的注入源会得出"tap 收不到事件"这种错误结论（我为此改了三次结论）。
// 组合键取四修饰键 + M：几乎不可能和任何应用自己的快捷键撞上。
test("an armed appshot hotkey fires when its chord is dispatched", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const armed = (await driver.daemonCommand("appshot_monitor_start", { hotkey: "Ctrl+Alt+Cmd+Shift+M" })).data as { armed?: boolean };
    assert.equal(armed.armed, true, "会话 tap 建不起来时这里会失败 —— 那是环境问题，不是逻辑问题");

    const before = (await driver.daemonCommand("appshot_status")).data as { eventsSeen?: number };
    await driver.daemonCommand("press_key", { pid: process.pid, key: "ctrl+alt+cmd+shift+m", global: true });
    await new Promise(resolve => setTimeout(resolve, 2500));

    const after = (await driver.daemonCommand("appshot_status")).data as { eventsSeen?: number; lastCapture?: string };
    assert.ok((after.eventsSeen ?? 0) > (before.eventsSeen ?? 0), "tap 应当收到那次按键");
    assert.ok((after.lastCapture ?? "").endsWith(".jpg"), "热键应当触发一次抓取并留下文件");
  } finally {
    await driver.daemonCommand("appshot_monitor_stop").catch(() => undefined);
    await driver.dispose();
  }
});

// 参照的 helper 有正经 usage：`daemon [--socket PATH] [--idle-seconds N]` / `version`，
// 并注明用户不需要手动运行。本实现原先忽略子命令、缺 --socket 就静默 exit(64) ——
// "可以手动跑"这条路径是断的（跑一下什么都不说，很费解）。
test("the daemon answers version and prints usage for an unknown subcommand", () => {
  const binary = new URL("../out/native/computer-use", import.meta.url).pathname;
  const version = spawnSync(binary, ["version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^native-\d+$/);

  const bogus = spawnSync(binary, ["definitely-not-a-subcommand"], { encoding: "utf8" });
  assert.notEqual(bogus.status, 0, "未知子命令应当非零退出");
  assert.match(bogus.stderr, /unknown subcommand/);
  assert.match(bogus.stdout, /用法:/, "要告诉用户正确的用法，而不是什么都不说");
});

// 参照对「AX 树读回来是空的」有唤醒重试（wakeupAttempts / wakeupDurationMs /
// no_wakeup_budget / empty_after_wakeup）：有些应用在 app nap 或懒加载时第一遍就是空的。
// 用尽预算仍为空要**明说**，让调用方分得清"这应用没有 AX 树"和"我该再试一次"。
test("an empty accessibility tree is retried, and says so when it stays empty", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("wake-e2e", undefined);
    const apps = (listed.data as { apps: { pid?: number; name?: string }[] }).apps;
    // 需要一棵**本来就空**的 AX 树来触发重试；找不到就跳过，不伪造场景
    for (const app of apps) {
      if (typeof app.pid !== "number") continue;
      const data = (await driver.daemonCommand("get_app_state", { pid: app.pid, no_shot: true, max_elements: 40 })).data as
        { elements?: { role?: string }[]; wakeupAttempts?: number; warning?: string };
      const meaningful = (data.elements ?? []).filter(element => element.role !== "AXWindow");
      if (meaningful.length > 0) continue;
      assert.ok((data.wakeupAttempts ?? 0) > 0, `${app.name} 的树是空的，应当尝试唤醒`);
      assert.match(data.warning ?? "", /empty_after_wakeup/, "重试后仍为空要说清楚，别让调用方以为该再试");
      return;
    }
  } finally {
    await driver.dispose();
  }
});

// shape() 在有截图时会**重建**回执对象 —— 只搬运它认识的字段，新加的就静默消失。
// 这就是 wakeupAttempts 带截图时不见、不带截图时还在的原因，表现形式是
// 「同一功能两次测出不同结果」。凡是 daemon 新加的字段都必须过这一关。
test("daemon fields survive the screenshot path, which rebuilds the reply", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("shape-e2e", undefined);
    const apps = (listed.data as { apps: { pid?: number }[] }).apps;
    const target = apps.find(app => typeof app.pid === "number");
    if (!target?.pid) return;

    const withShot = (await driver.daemonCommand("get_app_state", { pid: target.pid, max_elements: 30 })).data as Record<string, unknown>;
    const noShot = (await driver.daemonCommand("get_app_state", { pid: target.pid, no_shot: true, max_elements: 30 })).data as Record<string, unknown>;

    assert.ok(withShot.screenshot_width !== undefined, "带截图时应当带上截图尺寸");
    assert.equal("screenshot" in withShot, false, "daemon 的临时截图路径不该泄漏出去");
    // 两条路的**元素引用字段名不同**（有截图走 shape 映射给 element_token，
    // no_shot 直出 daemon 的 ref）—— 契约不同是有原因的（captureSchema 要求截图宽为正，
    // "没有截图"满足不了它）。但**两边都必须给出可用的引用**，否则拿到树也点不动。
    const tokenOf = (data: Record<string, unknown>) =>
      (data.elements as { element_token?: string; ref?: string }[] | undefined)?.map(element => element.element_token ?? element.ref);
    assert.deepEqual(tokenOf(withShot), tokenOf(noShot), "带不带截图，元素引用都该在、且对得上");
    assert.ok((tokenOf(noShot)?.length ?? 0) > 0, "no_shot 也必须给引用 —— 否则行集没有 ref，点了没用");
  } finally {
    await driver.dispose();
  }
});

// `type` 的三种模式对应参照的三条路径（"appending to AXValue" / "inserting at selection" /
// 直接写值）。**insert 是光标处插入，不是替换整段** —— 自绘输入框唯一走得通的路，
// 也是 `type_text` 三级降级里够不到的"第一级 AX 插入"。
//
// ⚠️ 这条测试**必须自建一次性文档**：早先的版本遍历应用挑第一个有文本域的往里写，
// 那会把用户真实界面里的输入框内容覆盖掉。写入类测试不能用"随便找一个"当目标。
test("type can insert at the cursor instead of replacing the whole value", async () => {
  const scratch = "/tmp/biny-cu-insert-test.txt";
  writeFileSync(scratch, "AAAABBBB");
  spawnSync("open", ["-a", "TextEdit", scratch]);
  await new Promise(resolve => setTimeout(resolve, 2000));

  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  const pid = Number(spawnSync("pgrep", ["-f", "TextEdit$"], { encoding: "utf8" }).stdout.trim().split("\n")[0]);
  try {
    assert.ok(pid > 0, "TextEdit 应当起来了");
    const observed = await driver.daemonCommand("get_app_state", { pid, no_shot: true, max_elements: 40 });
    type El = { element_token?: string; ref?: string; role?: string; value?: unknown };
    const area = ((observed.data as { elements?: El[] }).elements ?? []).find(element => element.role === "AXTextArea");
    const ref = area?.element_token ?? area?.ref;
    assert.ok(ref, "应当找得到那个一次性文档的文本域");
    assert.equal(String(area?.value ?? ""), "AAAABBBB", "一次性文档的内容应当是我们刚写进去的");

    // 光标放到第 4 个字符后，再插入 —— 结果应当插在中间，而不是替换整段
    await driver.daemonCommand("select_text", { pid, ref, location: 4, length: 0 });
    const inserted = (await driver.daemonCommand("type", { pid, ref, text: "XX", mode: "insert" })).data as { mode?: string };
    assert.equal(inserted.mode, "insert");

    const after = await driver.daemonCommand("get_app_state", { pid, no_shot: true, max_elements: 40 });
    const value = String(((after.data as { elements?: El[] }).elements ?? []).find(element => element.role === "AXTextArea")?.value ?? "");
    assert.equal(value, "AAAAXXBBBB", `应当插在光标处而不是替换整段（实际 ${JSON.stringify(value)}）`);
  } finally {
    await driver.dispose();
    // ⚠️ 用 `close ... saving no` 会**超时**（TextEdit 的 scripting 会挂住，实测 -1712），
    // 于是窗口留在用户屏幕上、文件却已删掉。按关闭按钮那条路是可靠的。
    spawnSync("osascript", ["-e",
      'tell application "System Events" to tell process "TextEdit" to perform action "AXPress" of (first button of window "biny-cu-insert-test.txt")']);
    rmSync(scratch, { force: true });
  }
});

// 「没传参数」和「ref 过期了」是两种完全不同的坏法，调用方要做的下一步也不同：
// 前者是补参数，后者是重新 snap。合成一句话会让调用方对着"需要 ref"发呆 ——
// 而他明明给了 ref，只是过期了。这条不变量在 set_value / select_text / click / menu 上
// 都要成立，所以逐个钉住（click 和 menu 上就先后漏过一次）。
test("a missing argument and an expired ref are reported differently", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const listed = await driver.list("err-e2e", undefined);
    const apps = (listed.data as { apps: { pid?: number }[] }).apps;
    const pid = apps.find(app => typeof app.pid === "number")?.pid;
    assert.ok(pid, "至少要有一个运行中的应用");
    const expired = "e999999";   // 不可能出现在任何一次观察里

    for (const [tool, missing, stale] of [
      ["click", { pid }, { pid, ref: expired }],
      ["perform_secondary_action", { pid }, { pid, ref: expired }],
      ["set_value", { pid, value: "x" }, { pid, ref: expired, value: "x" }],
      ["select_text", { pid }, { pid, ref: expired }]
    ] as const) {
      await assert.rejects(
        () => driver.daemonCommand(tool, missing),
        error => /needs_ref_or_pixel|missing_argument/.test(String(error)),
        `${tool} 没传目标时应当说"缺参数"`
      );
      await assert.rejects(
        () => driver.daemonCommand(tool, stale),
        error => /element_ref_not_observed/.test(String(error)),
        `${tool} 传了过期 ref 时应当说"ref 不在最近一次观察里"，而不是"缺参数"`
      );
    }
  } finally {
    await driver.dispose();
  }
});

// 意图层是"不驱动 UI、把意图派给应用"的那一层。参照的意图目录比本实现宽：
// 除具名的网易云路由外，还有一条**通用派发**（raw `orpheus://route/<name>` bridge，
// 未知名字照样放行 —— 参照自己写着 "Other values may also work"），
// 以及 Music.app / Spotify / 邮件。
test("intent layer dispatches generic routes and builds mailto URLs", async () => {
  const driver = new NativeProcessDriver(() => {}, {
    binaryPath: new URL("../out/native/computer-use", import.meta.url).pathname
  });
  try {
    const play = async (intent: string, args?: Record<string, unknown>) =>
      (await driver.daemonCommand("intent", args ? { intent, args } : { intent })).data as { url?: string; handler?: string };

    // 通用派发：已知路由和未知路由都应当**原样**构成 orpheus://route/<name>
    assert.equal((await play("netease_route", { id: "ranking" })).url, "orpheus://route/ranking");
    assert.equal((await play("netease_route", { id: "no_such_route" })).url, "orpheus://route/no_such_route",
      "未知路由名也要放行 —— 参照写着 Other values may also work");
    // 具名路由就是它的特例
    assert.equal((await play("play_daily_recommendation")).url, "orpheus://route/dailyRecommend");

    // 邮件：只拼调用方给了的字段（参照："All params optional: to, subject, body, cc, bcc"）
    assert.equal((await play("compose_mail", { to: "a@b.c", subject: "hi" })).url, "mailto:a@b.c?subject=hi");
    assert.equal((await play("compose_mail", {})).url, "mailto:");
    // 参数名：id 和 url 都认（调用方直觉会写 url）
    assert.equal((await play("open_music_url", { url: "https://music.apple.com/album/1" })).url,
      "https://music.apple.com/album/1");
    // ⚠️ Spotify 不一定装了 —— 不能断言一个取决于机器的值（我在这上面栽过一次：
    // focusTap 探针）。装了就看 URL 对不对，没装就看它报的是"没处理者"、
    // 而不是"名字不认识"。两种都要过，但**两种必须分得开**。
    const spotify = await play("play_spotify_uri", { id: "spotify:track:x" })
      .then(result => result.url ?? "")
      .catch(error => String(error));
    assert.match(String(spotify), /spotify:track:x|intent_handler_not_installed/);

    // 四种坏法必须分得清 —— 「名字不认识」和「名字对但没给 url」下一步完全不同
    await assert.rejects(() => play("no_such_intent"), /unknown_intent/);
    await assert.rejects(() => play("open_music_url"), /intent_missing_url/);
    await assert.rejects(() => play("open_url"), /intent_missing_url/);
  } finally {
    await driver.dispose();
  }
});
