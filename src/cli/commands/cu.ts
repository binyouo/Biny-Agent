import { z } from "zod";
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { NativeProcessDriver } from "../../computer/nativeDriver.js";
import { renderElementTree, type ElementLike } from "../../computer/elementTree.js";

/** 用户显式调用的原生入口；独立于模型控制器的审批和一次性观察凭据。 */
export function registerCuCommands(program: Command): void {
// Commander 将否定选项表示为 cursor:false，不能读取 noCursor。
const withCursorFlag = (options: Record<string, unknown>): Record<string, unknown> =>
  options.cursor === false ? { show_cursor: false } : {};

/**
 * 只在真的给了 `--pid` 时才带 pid。
 *
 * `Number(undefined)` 是 NaN，JSON 化后是 `null` —— 守护进程于是把 pid 读成"没给"，
 * 转头去解析 bundle，最后报 `app_not_found`；而调用方明明只是想用 ref。
 * 参照的调用方**根本不给 pid**（它的元素存储是全局的），ref 该能自己反查最近一次
 * 观察的 pid —— 守护进程侧见 `pidForRef`。
 */
const withPid = (options: { pid?: string }): Record<string, unknown> =>
  options.pid ? { pid: Number(options.pid) } : {};

const cu = program.command("cu").description("Drive the Mac from the terminal (same daemon the agent uses)");

  /** 每个动词都开一次守护进程连接；用完就断，空闲自退交给守护进程自己管。 */
  const withDriver = async <T>(work: (driver: NativeProcessDriver) => Promise<T>): Promise<T> => {
    const driver = new NativeProcessDriver(() => undefined);
    try {
      return await work(driver);
    } finally {
      // 放手而不是停掉：ref 表在守护进程里，杀掉它 = 每条命令都从零开始。
      driver.detach();
    }
  };

  const print = (value: unknown, json?: boolean): void => {
    console.log(json ? JSON.stringify(value, null, 2) : typeof value === "string" ? value : JSON.stringify(value, null, 2));
  };

  /** `<bundle|pid>`：纯数字当 pid，其余当 bundle id —— 跟守护进程的 resolvePid 一致。 */
  const target = (value: string): { pid: number } | { bundle: string } =>
    /^\d+$/.test(value) ? { pid: Number(value) } : { bundle: value };

  const windowOption = (options: { window?: string }): Record<string, unknown> =>
    options.window === undefined ? {} : { window_id: Number(options.window) };

  const pip = cu.command("pip").description("Mirror an exact window without activating its app");
  pip.command("open <window-id>").option("--pid <n>", "expected window owner")
    .option("--on-minimize", "show the mirror when the user minimizes the target").option("--json", "print JSON")
    .action((id: string, options: { pid?: string; onMinimize?: boolean; json?: boolean }) => withDriver(async driver => {
      print((await driver.daemonCommand("pip_open", { window_id: Number(id), pid: options.pid === undefined ? undefined : Number(options.pid), on_minimize: options.onMinimize })).data, options.json);
    }));
  pip.command("list").option("--json", "print JSON").action((options: { json?: boolean }) => withDriver(async driver => {
    print((await driver.daemonCommand("pip_list")).data, options.json);
  }));
  pip.command("close [window-id]").option("--all", "close and disarm every mirror").option("--json", "print JSON")
    .action((id: string | undefined, options: { all?: boolean; json?: boolean }) => withDriver(async driver => {
      print((await driver.daemonCommand("pip_close", { window_id: id === undefined ? undefined : Number(id), all: options.all })).data, options.json);
    }));

  cu.command("status").description("Helper bundle + daemon status").option("--json", "print JSON")
    .action((options: { json?: boolean }) => withDriver(async driver => {
      const data = (await driver.daemonCommand("status")).data;
      if (options.json) return print(data, true);
      print([
        `版本        ${String(data.version)}`,
        `helper 包   ${data.helperPresent ? "在" : "缺失"}  ${String(data.helper)}`,
        `守护进程    已跑 ${String(data.uptimeSeconds)}s，${String(data.idleSeconds)}s 无活动后自退`,
        `socket      ${String(data.socket)}`,
        `辅助功能    ${data.accessibility ? "已授权" : "未授权"}`,
        `屏幕录制    ${data.screenRecording ? "已授权" : "未授权"}`,
      ].join("\n"));
    }));

  cu.command("doctor").description("Ping the daemon and report both permissions").option("--json", "print JSON")
    .action((options: { json?: boolean }) => withDriver(async driver => {
      const data = (await driver.daemonCommand("doctor")).data;
      print(data, options.json);
    }));

  cu.command("grant").description("Trigger the Accessibility permission dialog").option("--json", "print JSON")
    .action((options: { json?: boolean }) => withDriver(async driver => {
      const data = (await driver.daemonCommand("grant")).data;
      print(data, options.json);
    }));

  for (const [name, days] of [["list_apps", true], ["apps", false]] as const) {
    const command = cu.command(name)
      .description(days ? "Running apps plus those used recently (with the bundle ids to launch)" : "Running apps only")
      .option("--json", "print JSON").option("--no-cursor", "hide the action indicator for this one action");
    if (days) command.option("--days <n>", "how far back to look for recent apps (0–90)", "14");
    command.action(async (options: { json?: boolean; days?: string }) => withDriver(async driver => {
      const apps = ((await driver.daemonCommand("list_apps", { recent_days: days ? z.number().int().min(0).max(90).parse(Number(options.days)) : 0 })).data as { apps?: never[] }).apps ?? [];
      if (options.json) return print(apps, true);
      print(apps.map((app: { running?: boolean; active?: boolean; name?: string; bundleId?: string; pid?: number; lastUsed?: string; useCount?: number }) =>
        `${app.active ? "*" : app.running ? "R" : " "} ${String(app.bundleId ?? "").padEnd(34)} ${String(app.pid ?? "").padEnd(7)} ${String(app.name ?? "")}${app.useCount === undefined ? "" : `  (${app.useCount}×)`}${app.lastUsed ? `  (${app.lastUsed})` : ""}`
      ).join("\n"));
    }));
  }

  cu.command("windows").description("List the windows of a running app").argument("<bundle|pid>", "app bundle id or pid")
    .option("--json", "print JSON")
    .action((value: string, options: { json?: boolean }) => withDriver(async driver => {
      const resolved = target(value);
      let pid = "pid" in resolved ? resolved.pid : undefined;
      if ("bundle" in resolved) {
        const apps = ((await driver.list("cli", undefined, undefined, 0)).data as { apps?: { pid?: number; bundleId?: string }[] }).apps ?? [];
        pid = apps.find(app => app.bundleId === resolved.bundle)?.pid;
        if (pid === undefined) throw new Error(`app_not_running: ${value}`);
      }
      pid = z.number().int().positive().max(2147483647).parse(pid);
      const apps = ((await driver.list("cli", pid)).data as { apps?: { pid: number; windows?: { window_id: number; title: string; frame?: { w: number; h: number }; focused?: boolean; minimized?: boolean }[] }[] }).apps ?? [];
      const app = apps.find(app => app.pid === pid);
      if (!app) throw new Error(`app_not_running: ${value}`);
      const windows = app.windows ?? [];
      if (options.json) return print(windows, true);
      print(windows.map(w => `${w.focused ? "*" : " "} ${String(w.window_id).padEnd(8)} ${w.frame ? `${String(w.frame.w)}×${String(w.frame.h).padEnd(6)}` : "(尺寸未知)"} ${w.title}${w.minimized ? "  已最小化" : ""}`).join("\n") || "(没有窗口)");
    }));

for (const observeName of ["get_app_state", "snap"] as const) {
const command = cu.command(observeName).description(observeName === "snap" ? "Read the accessibility tree without taking a screenshot" : "Observe a window: accessibility tree plus a screenshot").argument("<bundle|pid>", "app bundle id or pid")
    .option("--all", "include every element, not just the interactive ones")
    .option("--window <id>", "exact window id from `cu windows`")
    .option("--depth <n>", "how deep to walk the accessibility tree")
    .option("--json", "print JSON");
if (observeName === "get_app_state") command
    .option("--shot-max-width <n>", "downsample width of the screenshot jpg (daemon default 1280)")
    .option("--shot-out <path>", "write the screenshot to this path (alias of --out)")
    .option("--out <path>", "where to write the jpg")
    .option("--no-shot", "skip the screenshot and read only the tree");
command.action(async (value: string, options: { window?: string; out?: string; shotOut?: string; depth?: string; shot?: boolean; all?: boolean; shotMaxWidth?: string; json?: boolean }) => withDriver(async driver => {
      const noShot = observeName === "snap" || options.shot === false;
      const args = {
        ...target(value), ...windowOption(options),
        ...(options.depth ? { max_depth: Number(options.depth) } : {}),
        ...(options.all ? { interactive_only: false } : {}),
        ...(options.shotMaxWidth ? { max_width: Number(options.shotMaxWidth) } : {}),
        // Commander 把 --no-shot 变成 shot:false
        ...(noShot ? { no_shot: true } : {})
      };
      const reply = await driver.daemonCommand("get_app_state", args);
      const data = reply.data as { window_id?: number; windowId?: number; elements?: ElementLike[]; screenshot_width?: number; screenshot_height?: number; screenshot_error?: string };
      const windowId = data.window_id ?? data.windowId;
      const image = noShot ? undefined : reply.images[0];
      let screenshot: string | undefined;
      if (image) {
        screenshot = path.resolve(options.out ?? options.shotOut ?? path.join(os.tmpdir(), `biny-cu-state-${randomUUID()}.jpg`));
        const temporary = path.join(path.dirname(screenshot), `.biny-capture-${randomUUID()}.jpg`);
        const file = await open(temporary, "wx", 0o600);
        try {
          try { await file.writeFile(Buffer.from(image.dataBase64, "base64")); } finally { await file.close(); }
          await rename(temporary, screenshot);
        } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
      }
      const tree = renderElementTree(data.elements);
      if (options.json) return print({ ...data, window_id: windowId, screenshot, tree }, true);
      // --no-shot 时没有截图，也就没有尺寸 —— 别把 undefined 打给用户。
      const header = [
        windowId === undefined ? undefined : `窗口 ${String(windowId)}`,
        data.screenshot_width ? `${String(data.screenshot_width)}×${String(data.screenshot_height)}` : "(未截图)",
        screenshot ? `截图 ${screenshot}` : data.screenshot_error
      ].filter(Boolean).join("  ");
      print([header, "", tree].join("\n"));
    }));
}

  cu.command("shot").description("Capture one window to a file").argument("<bundle|pid>", "app bundle id or pid")
    .option("--window <id>", "exact window id").option("--out <path>", "where to write the jpg")
    .option("--max-width <n>", "downsample width of the jpg (daemon default 1280)")
    .option("--json", "print JSON")
    .action((value: string, options: { window?: string; out?: string; maxWidth?: string; json?: boolean }) => withDriver(async driver => {
      const out = path.resolve(options.out ?? path.join(os.tmpdir(), `biny-cu-${randomUUID()}.jpg`));
      const data = (await driver.daemonCommand("capture_screen", {
        ...target(value),
        window_id: options.window ? Number(options.window) : undefined,
        out,
        ...(options.maxWidth ? { max_width: Number(options.maxWidth) } : {})
      })).data;
      if (options.json) return print(data, true);
      print(String((data as { path?: string }).path ?? out));
    }));

  cu.command("click").description("Click an element ref, or a screenshot pixel").argument("[ref]", "element ref from `cu snap`")
    .option("--pixel <x> <y...>", "click at these screenshot pixels instead").option("--pid <n>", "target pid when clicking a pixel")
    .option("--window <id>", "exact window id for background physical input")
    .option("--button <name>", "left | right | middle", "left").option("--clicks <n>", "1 = single, 2 = double-click", "1")
    .option("--strategy <name>", "auto | ax | physical — auto prefers a physical click when bounds exist; ax drives the control's own action", "auto")
    .option("--json", "print JSON")
    .option("--no-cursor", "hide the action indicator for this one action")
    .action(async (ref: string | undefined, options: { pixel?: string[]; pid?: string; window?: string; button?: string; clicks?: string; strategy?: string; cursor?: boolean; json?: boolean }) => withDriver(async driver => {
      const shared = { button: z.enum(["left", "right", "middle"]).parse(options.button), clicks: Number(options.clicks), strategy: options.strategy, ...withCursorFlag(options) };
      const args: Record<string, unknown> = options.pixel
        ? { ...withPid(options), x: Number(options.pixel[0]), y: Number(options.pixel[1]), ...shared }
        : { ref, ...withPid(options), ...shared };
      print((await driver.daemonCommand("click", { ...args, ...windowOption(options) })).data, options.json);
    }));

  for (const verb of ["type_text", "press_key"] as const) {
    const command = cu.command(verb).description(verb === "type_text" ? "Type text into the target app" : "Press a key or chord (xdotool syntax: cmd+s)")
      .argument(verb === "type_text" ? "<text>" : "<combo>").option("--pid <n>", "target pid").option("--json", "print JSON").option("--no-cursor", "hide the action indicator for this one action");
    // `global` 是 press_key 独有的：默认投给目标进程（后台应用也能收、不动前台），
    // 系统级快捷键表达不出来时走上这条 —— 代价是会被前台应用收掉，所以要显式选。
    if (verb === "press_key") {
      command.option("--global", "deliver through the global HID stream to whatever is focused (needed for system-level shortcuts); default posts to the target process");
    } else {
      command.option("--input-method <method>", "auto | physical | unicode | ax (default: auto)")
        .option("--input_method <method>", "alias of --input-method")
        .option("--bundle <id>", "target application bundle id")
        .option("--ref <ref>", "element reference for ax input");
    }
    command.action((value: string, options: { pid?: string; bundle?: string; json?: boolean; global?: boolean; inputMethod?: string; input_method?: string; ref?: string }) => withDriver(async driver => {
      const args = verb === "type_text"
        ? { text: value, input_method: options.inputMethod ?? options.input_method ?? "auto", bundle: options.bundle, ref: options.ref, ...withPid(options) }
        : { key: value, ...withPid(options), ...(options.global ? { global: true } : {}) };
      print((await driver.daemonCommand(verb, { ...args, ...withCursorFlag(options) })).data, options.json);
    }));
  }

  cu.command("appshot").description("Capture the current application's window").option("--json", "print JSON")
    .action((options: { json?: boolean }) => withDriver(async driver => {
      print((await driver.daemonCommand("appshot_capture", { include_ax: true })).data, options.json);
    }));

  cu.command("scroll").description("Scroll the target window, or a given element's scroll area")
    .argument("[refOrDirection]", "element ref (e12) or direction: up | down | left | right")
    .argument("[direction]", "up | down | left | right — required when a ref is given")
    .option("--pid <n>", "target pid")
    .option("--pages <n>", "pages computed from the scroll area (default: 1 when using a ref)")
    .option("--amount <n>", "line notches instead of pages; --pages takes precedence (default: 1 without a ref)")
    .option("--no-cursor", "hide the action indicator for this one action")
    .option("--json", "print JSON")
    .action((refOrDirection: string, direction: string | undefined, options: { pid?: string; pages?: string; amount?: string; json?: boolean }) => withDriver(async driver => {
      const looksLikeRef = /^e\d+$/.test(refOrDirection);
      const dir = looksLikeRef ? direction : refOrDirection;
      if (!dir) throw new Error("scroll 需要方向：cu scroll <ref> <up|down|left|right> 或 cu scroll <direction> --pid N");
      const args: Record<string, unknown> = {
        direction: dir,
        ...withPid(options),
        ...(looksLikeRef ? { ref: refOrDirection } : {})
      };
      if (options.pages !== undefined || (looksLikeRef && options.amount === undefined)) args.pages = Number(options.pages ?? 1);
      else args.amount = Number(options.amount ?? 1);
      print((await driver.daemonCommand("scroll", { ...args, ...withCursorFlag(options) })).data, options.json);
    }));

  cu.command("drag").description("Drag between two screenshot points").arguments("<x1> <y1> <x2> <y2>")
    .option("--pid <n>", "target pid").option("--window <id>", "exact window id for background physical input").option("--json", "print JSON")
    .option("--button <name>", "left | right | middle", "left")
    .option("--no-cursor", "hide the action indicator for this one action")
    .action((x1: string, y1: string, x2: string, y2: string, options: { pid?: string; window?: string; button?: string; json?: boolean }) => withDriver(async driver => {
      const points = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).parse([x1, y1, x2, y2].map(value => Number.parseFloat(value)));
      const button = z.enum(["left", "right", "middle"]).parse(options.button);
      print((await driver.daemonCommand("drag", { x1: points[0], y1: points[1], x2: points[2], y2: points[3], button, ...withPid(options), ...windowOption(options), ...withCursorFlag(options) })).data, options.json);
    }));

  // 参照里这个名字叫 `perform_secondary_action`，且**两种定位方式**：
// `perform_secondary_action <ref>` 与 `perform_secondary_action --pixel <x> <y> [--pid=N]`。
// 本实现原先只有 `menu`（ref 一种），名字和像素形式都缺。
for (const menuName of ["perform_secondary_action", "menu"] as const) {
cu.command(menuName).description("Open an element's context menu").argument("[ref]", "element ref from `cu snap`")
    .option("--pixel <x> <y...>", "click at screenshot coordinates instead")
    .option("--pid <n>", "target pid").option("--window <id>", "exact window id for background physical input").option("--json", "print JSON")
    .option("--no-cursor", "hide the action indicator for this one action")
    .action((ref: string | undefined, options: { pixel?: string[]; pid?: string; window?: string; json?: boolean }) => withDriver(async driver => {
      if (ref && options.pixel) throw new Error(`${menuName} 只能二选一：ref 或 --pixel`);
      const where = options.pixel
        ? { x: Number(options.pixel[0]), y: Number(options.pixel[1]) }
        : ref ? { ref } : null;
      if (!where) throw new Error(`${menuName} 需要 ref 或 --pixel <x> <y>`);
      print((await driver.daemonCommand("perform_secondary_action", { ...where, ...withPid(options), ...windowOption(options), ...withCursorFlag(options) })).data, options.json);
    }));
}

  const elementVerb = (name: string, description: string, extra: (value: string, options: Record<string, unknown>) => Record<string, unknown>) => {
    const command = cu.command(name).description(description).argument("<ref>", "element ref from `cu snap`")
      .argument("<value>", name === "press" ? "Enter | Escape | Space | Increment | Decrement | ShowMenu" : "text")
      .option("--pid <n>", "target pid").option("--json", "print JSON")
      .option("--no-cursor", "hide the action indicator for this one action");
    if (name === "type") {
      command.option("--append", "append instead of replacing the value");
      command.option("--at-selection", "insert at the selection (a cursor position when nothing is selected)");
    }
    command.action((ref: string, value: string, options: Record<string, unknown>) => withDriver(async driver => {
      print((await driver.daemonCommand(name, { ref, ...withPid(options), ...extra(value, options), ...withCursorFlag(options) })).data, options.json === true);
    }));
  };

  // 元素级输入：改控件自己的 AXValue / 触发它的 AX 动作，**不经过键盘焦点**。
  // 自绘输入框（收不到合成按键的那类）只有这条路走得通。
  // 三种模式对应参照的三条路径：直接写值 / 追加到 AXValue / 在选区处插入。
  // insert 是**光标处插入**（空选区即光标），不是替换整段 —— 自绘输入框只有这条路。
  elementVerb("type", "Write text into an element through its accessibility value", (value, options) => ({
    text: value,
    mode: options.atSelection === true ? "insert" : options.append === true ? "append" : "replace"
  }));
  elementVerb("press", "Trigger an element's accessibility action", value => ({ key: value }));

  cu.command("set_value").description("Write an accessibility value directly (skips keystrokes)").argument("<ref>").argument("<value>")
    .option("--pid <n>", "target pid").option("--json", "print JSON")
    .option("--no-cursor", "hide the action indicator for this one action")
    .action((ref: string, value: string, options: { pid?: string; json?: boolean }) => withDriver(async driver => {
      const typed = value === "true" ? true : value === "false" ? false : value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
      print((await driver.daemonCommand("set_value", { ref, value: typed, ...withPid(options), ...withCursorFlag(options) })).data, options.json);
    }));

  cu.command("launch_app").alias("launch").description("Launch an app in the background (never takes the foreground)").argument("<bundle>")
    .option("--activates", "bring it to the front afterwards — off by default, because starting an app should not move the user's focus")
    .option("--json", "print JSON")
    .action((bundle: string, options: { activates?: boolean; json?: boolean }) => withDriver(async driver => {
      const reply = options.activates
        ? await driver.daemonCommand("launch_app", { bundle, activates: true })
        : await driver.launchApp(bundle);
      print(reply, options.json);
    }));

  cu.command("raise").description("Bring an app (or one of its windows) to the front").argument("<bundle|pid>")
    .option("--window <id>", "exact window id").option("--json", "print JSON")
    .action((value: string, options: { window?: string; json?: boolean }) => withDriver(async driver => {
      print((await driver.daemonCommand("raise", { ...target(value), ...windowOption(options) })).data, options.json);
    }));

  cu.command("lens").description("Show or hide the action indicator that marks where the agent acts")
    .argument("[mode]", "on | off | toggle (default: toggle)")
    .option("--json", "print JSON")
    .action((mode: string | undefined, options: { json?: boolean }) => withDriver(async driver => {
      const selected = z.enum(["on", "off", "toggle", "true", "false", "1", "0", "status", "report", "get"]).parse(mode ?? "toggle");
      const data = (await driver.daemonCommand("lens", { mode: selected })).data;
      print(options.json ? data : `lens: ${(data as { enabled?: boolean }).enabled ? "on" : "off"}`, options.json);
    }));

  cu.command("intent").description("Dispatch a registered app-native intent instead of driving the UI")
    .argument("[name]", "intent name (open_url | play_song | play_playlist | play_daily_recommendation | open_history_recommend)")
    .option("--url <url>", "for open_url: the URL to route to its handler").option("--id <id>", "for song/playlist intents")
    .option("--bundle <id>", "override the target app").option("--json", "print JSON")
    .action((name: string | undefined, options: { url?: string; id?: string; bundle?: string; json?: boolean }) => withDriver(async driver => {
      const args: Record<string, unknown> = { intent: name ?? "open_url" };
      if (options.url) args.url = options.url;
      if (options.id) args.args = { id: options.id };
      if (options.bundle) args.bundle = options.bundle;
      print((await driver.daemonCommand("intent", args)).data, options.json);
    }));

  cu.command("shutdown").description("Stop the daemon (it otherwise exits after 900s idle)").option("--json", "print JSON")
    .action((options: { json?: boolean }) => withDriver(async driver => {
      print((await driver.daemonCommand("shutdown")).data, options.json);
    }));
}
