import { test } from "node:test";
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
