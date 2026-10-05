import type { Command } from "commander";
import { NativeProcessDriver } from "../../computer/nativeDriver.js";
import { renderElementTree, type ElementLike } from "../../computer/elementTree.js";

/**
 * `biny cu` —— 命令行的 macOS 桌面控制。
 *
 * 对 Alma 的 `cu`：同一台守护进程，同一个能力集，只是出口不同。Alma 把它算作
 * 「人和 LLM 共用一条控制面」（notes/19 §7），所以它**不经过**模型侧那三个工具
 * ——没有审批、没有审计、没有 capture 校验。那些是给模型上的护栏，人在这儿敲字
 * 时自己有判断。
 *
 * 它直连守护进程的 unix socket，因此**不需要桌面应用在运行**：守护进程按需自启。
 */
export function registerCuCommands(program: Command): void {
  /** 动作类动词：`--no-cursor` 对它们都成立（参照把它写在 "Action flags" 一节）。 */
const ACTION_VERBS = new Set(["click", "perform_secondary_action", "drag", "type", "type_text", "press", "press_key", "set_value", "select_text", "scroll"]);

/**
 * 动作级开关：`--no-cursor` → `show_cursor: false`。
 * 参照把它写在 help 的 "Action flags: --no-cursor hides the lens for one action"，
 * 对每个动作都成立 —— 所以它是**动作参数**，不是某个动词的私事。
 */
const withCursorFlag = (options: Record<string, unknown>): Record<string, unknown> =>
  options.noCursor === true ? { show_cursor: false } : {};

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
    if (days) command.option("--days <n>", "how far back to look for recent apps", "30");
    command.action(async (options: { json?: boolean; days?: string }) => withDriver(async driver => {
      const apps = ((await driver.list("cli", undefined)).data as { apps?: never[] }).apps ?? [];
      if (options.json) return print(apps, true);
      print(apps.map((app: { running?: boolean; name?: string; bundleId?: string; pid?: number; lastUsed?: string }) =>
        `${app.running ? "●" : "○"} ${String(app.bundleId ?? "").padEnd(34)} ${String(app.pid ?? "").padEnd(7)} ${String(app.name ?? "")}${app.lastUsed ? `  (${app.lastUsed})` : ""}`
      ).join("\n"));
    }));
  }

  cu.command("windows").description("List the on-screen windows of an app").argument("<bundle|pid>", "app bundle id or pid")
    .option("--json", "print JSON")
    .action((value: string, options: { json?: boolean }) => withDriver(async driver => {
      const resolved = target(value);
      const apps = ((await driver.list("cli", "pid" in resolved ? resolved.pid : undefined)).data as { apps?: { windows?: { window_id: number; title: string; frame: { w: number; h: number } }[] }[] }).apps ?? [];
      const windows = apps[0]?.windows ?? [];
      if (options.json) return print(windows, true);
      print(windows.map(w => `${String(w.window_id).padEnd(8)} ${String(w.frame.w)}×${String(w.frame.h).padEnd(6)} ${w.title}`).join("\n") || "(没有在屏窗口)");
    }));

  // 参照的 CLI 里这个能力叫 `get_app_state`，help 上写着 **"start every turn with
// `alma cu get_app_state <bundle>`"** —— 名字本身就是给 agent 的契约，不只是叫法。
// 本实现原先只有 `snap`（那是参照里 tree-only 的 legacy 名），能力在、名字不对。
// 两个名字都留：`get_app_state` 是主名（带 --shot-max-width），`snap` 保留原名。
for (const observeName of ["get_app_state", "snap"] as const) {
cu.command(observeName).description("Observe a window: accessibility tree plus a screenshot").argument("<bundle|pid>", "app bundle id or pid")
    .option("--shot-max-width <n>", "downsample width of the screenshot jpg (daemon default 1280)")
    .option("--window <id>", "exact window id from `cu windows`").option("--out <path>", "where to write the jpg")
    .option("--depth <n>", "how deep to walk the accessibility tree").option("--no-shot", "skip the screenshot and read only the tree")
    .option("--json", "print JSON")
    .action(async (value: string, options: { window?: string; out?: string; depth?: string; shot?: boolean; shotMaxWidth?: string; json?: boolean }) => withDriver(async driver => {
      const args = {
        ...target(value), ...windowOption(options),
        ...(options.out ? { out: options.out } : {}),
        ...(options.depth ? { max_depth: Number(options.depth) } : {}),
        // 参照在这一条上给的是 `--shot-max-width=N`（守护进程侧字段 max_width）。
        ...(options.shotMaxWidth ? { max_width: Number(options.shotMaxWidth) } : {}),
        // Commander 把 --no-shot 变成 shot:false
        ...(options.shot === false ? { no_shot: true } : {})
      };
      const reply = await driver.observeRaw(args);
      const data = reply.data as { window_id?: number; elements?: ElementLike[]; screenshot_width?: number; screenshot_height?: number };
      const tree = renderElementTree(data.elements);
      if (options.json) return print({ ...data, tree }, true);
      // --no-shot 时没有截图，也就没有尺寸 —— 别把 undefined 打给用户。
      const header = [
        data.window_id === undefined ? undefined : `窗口 ${String(data.window_id)}`,
        data.screenshot_width ? `${String(data.screenshot_width)}×${String(data.screenshot_height)}` : "(未截图)"
      ].filter(Boolean).join("  ");
      print([header, "", tree].join("\n"));
    }));
}

  cu.command("shot").description("Capture one window to a file").argument("<bundle|pid>", "app bundle id or pid")
    .option("--window <id>", "exact window id").option("--out <path>", "where to write the jpg")
    // 参照的这条 help 是 `shot <bundle|pid> [--window=ID] [--out=PATH] [--max-width=N]`。
    // 守护进程一直支持 max_width（默认 1280），CLI 没开口 —— 又是能力在、路不通。
    .option("--max-width <n>", "downsample width of the jpg (daemon default 1280)")
    .option("--json", "print JSON")
    .action((value: string, options: { window?: string; out?: string; maxWidth?: string; json?: boolean }) => withDriver(async driver => {
      const out = options.out ?? `/tmp/biny-cu-${Date.now()}.jpg`;
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
    .option("--button <name>", "left | right | middle", "left").option("--clicks <n>", "1 = single, 2 = double-click", "1")
    .option("--strategy <name>", "auto | ax | physical — ax drives the control's own action, physical synthesises a mouse click", "auto")
    .option("--json", "print JSON")
    .option("--no-cursor", "hide the action indicator for this one action")
    .action(async (ref: string | undefined, options: { pixel?: string[]; pid?: string; button?: string; clicks?: string; strategy?: string; noCursor?: boolean; json?: boolean }) => withDriver(async driver => {
      // `--no-cursor` 是**动作级**开关（参照写在 "Action flags" 里，不挑动词）：
      // 这一次不要指示器，下一次照旧。
      const shared = { button: options.button, clicks: Number(options.clicks), strategy: options.strategy, ...(options.noCursor ? { show_cursor: false } : {}) };
      const args: Record<string, unknown> = options.pixel
        ? { pid: Number(options.pid), x: Number(options.pixel[0]), y: Number(options.pixel[1]), ...shared }
        : { ref, pid: Number(options.pid), ...shared };
      print((await driver.actRaw("click", args)).data, options.json);
    }));

  for (const verb of ["type_text", "press_key"] as const) {
    const command = cu.command(verb).description(verb === "type_text" ? "Type text into the target app" : "Press a key or chord (xdotool syntax: cmd+s)")
      .argument(verb === "type_text" ? "<text>" : "<combo>").option("--pid <n>", "target pid").option("--json", "print JSON").option("--no-cursor", "hide the action indicator for this one action");
    command.action((value: string, options: { pid?: string; json?: boolean }) => withDriver(async driver => {
      const args = verb === "type_text" ? { text: value, pid: Number(options.pid) } : { key: value, pid: Number(options.pid) };
      print((await driver.actRaw(verb, { ...args, ...withCursorFlag(options) })).data, options.json);
    }));
  }

  cu.command("scroll").description("Scroll the target window, or a given element's scroll area")
    // 参照是 `cu scroll <ref> <up|down|left|right> [--pages=N]` —— **目标由 ref 指定**。
    // 原先是 `scroll <direction> --pid`，两种都留：第一个参数长得像 ref（e123）就按 ref 走。
    .argument("[refOrDirection]", "element ref (e12) or direction: up | down | left | right")
    .argument("[direction]", "up | down | left | right — required when a ref is given")
    .option("--pid <n>", "target pid")
    .option("--pages <n>", "whole pages (one page = viewport/content, computed from the scroll area)")
    .option("--amount <n>", "line notches instead of pages — an estimate, only used when --pages is absent", "1")
    .option("--json", "print JSON")
    .action((refOrDirection: string, direction: string | undefined, options: { pid?: string; pages?: string; amount?: string; json?: boolean }) => withDriver(async driver => {
      const looksLikeRef = /^e\d+$/.test(refOrDirection);
      const dir = looksLikeRef ? direction : refOrDirection;
      if (!dir) throw new Error("scroll 需要方向：cu scroll <ref> <up|down|left|right> 或 cu scroll <direction> --pid N");
      // 只给 ref 时不带 pid（参照的 `cu scroll <ref> <dir>` 就是不给 pid）；
      // 早先无条件传 `Number(undefined)` = NaN，daemon 于是报 app_not_found。
      const args: Record<string, unknown> = {
        direction: dir,
        ...(options.pid ? { pid: Number(options.pid) } : {}),
        ...(looksLikeRef ? { ref: refOrDirection } : {})
      };
      // 给了 --pages 就按页面走（量出来的），否则退回滚轮行数（估的）。回执里的 unit 会说明用了哪个。
      if (options.pages !== undefined) args.pages = Number(options.pages);
      else args.amount = Number(options.amount);
      print((await driver.actRaw("scroll", { ...args, ...withCursorFlag(options) })).data, options.json);
    }));

  cu.command("drag").description("Drag between two screenshot points").argument("<x1> <y1> <x2> <y2>")
    .option("--pid <n>", "target pid").option("--json", "print JSON")
    .action((x1: string, y1: string, x2: string, y2: string, options: { pid?: string; json?: boolean }) => withDriver(async driver => {
      print((await driver.actRaw("drag", { x1: Number(x1), y1: Number(y1), x2: Number(x2), y2: Number(y2), pid: Number(options.pid), ...withCursorFlag(options) })).data, options.json);
    }));

  // 参照里这个名字叫 `perform_secondary_action`，且**两种定位方式**：
// `perform_secondary_action <ref>` 与 `perform_secondary_action --pixel <x> <y> [--pid=N]`。
// 本实现原先只有 `menu`（ref 一种），名字和像素形式都缺。
for (const menuName of ["perform_secondary_action", "menu"] as const) {
cu.command(menuName).description("Open an element's context menu").argument("[ref]", "element ref from `cu snap`")
    .option("--pixel <x> <y...>", "click at screenshot coordinates instead")
    .option("--pid <n>", "target pid").option("--json", "print JSON")
    .action((ref: string | undefined, options: { pixel?: string[]; pid?: string; json?: boolean }) => withDriver(async driver => {
      if (ref && options.pixel) throw new Error(`${menuName} 只能二选一：ref 或 --pixel`);
      const where = options.pixel
        ? { x: Number(options.pixel[0]), y: Number(options.pixel[1]) }
        : ref ? { ref } : null;
      if (!where) throw new Error(`${menuName} 需要 ref 或 --pixel <x> <y>`);
      print((await driver.actRaw("perform_secondary_action", { ...where, ...(options.pid ? { pid: Number(options.pid) } : {}), ...withCursorFlag(options) })).data, options.json);
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
      print((await driver.daemonCommand(name, { ref, pid: Number(options.pid), ...extra(value, options), ...withCursorFlag(options) })).data, options.json === true);
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
    .action((ref: string, value: string, options: { pid?: string; json?: boolean }) => withDriver(async driver => {
      const typed = value === "true" ? true : value === "false" ? false : Number.isFinite(Number(value)) ? Number(value) : value;
      print((await driver.actRaw("set_value", { ref, value: typed, pid: Number(options.pid), ...withCursorFlag(options) })).data, options.json);
    }));

  cu.command("launch_app").description("Launch an app in the background (never takes the foreground)").argument("<bundle>")
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
      const data = (await driver.daemonCommand("lens", { mode: mode ?? "toggle" })).data;
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
