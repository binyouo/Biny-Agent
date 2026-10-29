import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createComputerUseMcpServer } from "../src/computer/mcpServer.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

test("sky retains multiplication signs in control labels and formats only frame dimensions", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  driver.daemonCommand = async () => ({ data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] });
  driver.observeRaw = async () => ({ data: { pid: 12, window_id: 9, elements: [
    { element_token: "e1", role: "AXButton", title: "屏幕 1920×1080", frame: { x: -5, y: 20, w: 40, h: 30 }, selected: true, actions: ["AXPress"] },
    { element_token: "e2", role: "AXButton", title: "3×3 矩阵", value: "5×5" }
  ] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] });
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-frame-label", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    assert.notEqual(result.isError, true);
    const body = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.match(body.text, /\[0\] Button "屏幕 1920×1080" @-5,20 40x30 \(selected\) actions=/);
    assert.match(body.text, /\[1\] Button "3×3 矩阵" value="5×5"/);
  } finally { await client.close(); await server.close(); await driver.dispose(); }
});

test("sky tools expose app discovery, observations and indexed actions through the same policy", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let observation = 0;
  driver.daemonCommand = async (cmd) => ({ data: cmd === "list_apps" ? { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true, useCount: 5 }] } : {}, images: [] });
  driver.observeRaw = async () => ({ data: { pid: 12, window_id: 9, bundleId: "test.app", elements: [{ element_token: `e${++observation}`, role: "AXButton", description: "Play", focused: true }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] });
  driver.actRaw = async (action, args) => { calls.push({ tool: action, args }); return { data: { effect: "confirmed" }, images: [] }; };
  driver.captureWindow = async () => ({ data: {}, images: [] });
  driver.capturePreview = async () => ({ data: {}, images: [] });
  const policyCalls: string[] = [];
  const server = createComputerUseMcpServer(driver, { run: async (tool, _args, operation) => { policyCalls.push(tool); return await operation(); } });
  const client = new Client({ name: "sky-contract", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ["sky_list_apps", "sky_get_app_state", "sky_click", "sky_press_key", "sky_type_text", "sky_scroll", "sky_set_value", "sky_drag", "sky_perform_secondary_action", "sky_select_text"]) assert.ok(names.includes(name), name);
    const list = await client.callTool({ name: "sky_list_apps", arguments: {} });
    const apps = JSON.parse((list.content as { text: string }[])[0]!.text);
    assert.equal(apps[0].id, "test.app"); assert.equal(apps[0].displayName, "Fixture");
    const read = async () => await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    const state = await read(); assert.notEqual(state.isError, true);
    const body = JSON.parse((state.content as { text: string }[])[0]!.text);
    assert.match(body.text, /\[0\] Button.*Play.*focused/);
    assert.equal(body.screenshot.url, "data:image/jpeg;base64,/9j/2Q==");
    const invalid = await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0, x: 1 } });
    assert.equal(invalid.isError, true); assert.equal(calls.length, 0);
    const clicked = await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0, mouse_button: "r", click_count: 2 } });
    assert.notEqual(clicked.isError, true); assert.equal(calls[0]!.args.ref, "e1"); assert.equal(calls[0]!.args.button, "right");
    const stale = await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0 } });
    assert.equal(stale.isError, true); assert.equal(calls.length, 1);
    await read();
    const wrongApp = await client.callTool({ name: "sky_click", arguments: { app: "test.other", element_index: 0 } });
    assert.equal(wrongApp.isError, true); assert.equal(calls.length, 1);
    const cases: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
      ["sky_press_key", { key: "Super_L+d" }, "press_key", { key: "Super_L+d" }],
      ["sky_type_text", { text: "hello" }, "type_text", { text: "hello" }],
      ["sky_scroll", { element_index: 0, direction: "d", pages: 2 }, "scroll", { direction: "down", pages: 2 }],
      ["sky_scroll", { element_index: 0, direction: "u", pages: 0.5 }, "scroll", { direction: "up", pages: 0.5 }],
      ["sky_set_value", { element_index: 0, value: "new" }, "set_value", { value: "new" }],
      ["sky_drag", { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, "drag", { x1: 1, y1: 2, x2: 3, y2: 4 }],
      ["sky_perform_secondary_action", { element_index: 0, action: "AXShowMenu" }, "perform_secondary_action", { secondary_action: "AXShowMenu" }],
      ["sky_perform_secondary_action", { element_index: 0, action: "AXPress" }, "perform_secondary_action", { secondary_action: "AXPress" }],
      ["sky_select_text", { element_index: 0, text: "target", prefix: "pre", selection_type: "cursor_after" }, "select_text", { match_text: "target", prefix: "pre", selection_type: "cursor_after" }]
    ];
    for (const [name, args, action, expected] of cases) {
      const refreshed = await read();
      const stateText = JSON.parse((refreshed.content as { text: string }[])[0]!.text).text as string;
      const freshIndex = Number(stateText.match(/^\[(\d+)\]/m)![1]);
      const observedRef = `e${observation}`;
      const reply = await client.callTool({ name, arguments: { app: "test.app", ...args, ...("element_index" in args ? { element_index: freshIndex } : {}) } });
      assert.notEqual(reply.isError, true, `${name}: ${JSON.stringify(reply.content)}`);
      const call = calls.at(-1)!; assert.equal(call.tool, action);
      for (const [key, value] of Object.entries(expected)) assert.equal(call.args[key], value, `${name} ${key}`);
      if ("element_index" in args) assert.equal(call.args.ref, observedRef);
    }
    assert.ok(policyCalls.includes("get_app_state")); assert.ok(policyCalls.includes("click"));
  } finally { await client.close(); await server.close(); await driver.dispose(); }
});

test("a late sky observation cannot replace a newer observation", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let count = 0;
  const refs: string[] = [];
  driver.daemonCommand = async () => ({ data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] });
  driver.observeRaw = async () => {
    const id = ++count;
    if (id === 1) { started(); await gate; }
    return { data: { pid: 12, window_id: 9, elements: [{ element_token: `e${id}`, role: "AXButton", title: `item ${id}` }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] };
  };
  driver.actRaw = async (_name, args) => { refs.push(String(args.ref)); return { data: { effect: "confirmed" }, images: [] }; };
  driver.captureWindow = async () => ({ data: {}, images: [] });
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-race", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const first = client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    await entered;
    const second = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    assert.notEqual(second.isError, true);
    release();
    assert.equal((await first).isError, true);
    const click = await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0 } });
    assert.notEqual(click.isError, true); assert.deepEqual(refs, ["e2"]);
  } finally { release(); await client.close(); await server.close(); await driver.dispose(); }
});

test("an older sky request cannot dispatch after a newer request resolves its app first", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let lists = 0, observations = 0;
  const refs: string[] = [];
  driver.daemonCommand = async () => {
    if (++lists === 1) { entered(); await gate; }
    return { data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] };
  };
  driver.observeRaw = async () => ({ data: { pid: 12, window_id: 9, elements: [{ element_token: `e${++observations}`, role: "AXButton", title: "Play" }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] });
  driver.actRaw = async (_name, args) => { refs.push(String(args.ref)); return { data: { effect: "confirmed" }, images: [] }; };
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-list-race", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const first = client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    await waiting;
    const second = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    assert.notEqual(second.isError, true);
    release();
    const older = await first;
    assert.equal(older.isError, true, "a superseded app lookup cannot start an observation");
    assert.equal(observations, 1);
    const click = await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0 } });
    assert.notEqual(click.isError, true); assert.deepEqual(refs, ["e1"]);
  } finally { release(); await client.close(); await server.close(); await driver.dispose(); }
});

test("a pending newer sky request prevents an older observation from becoming current", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  let releaseObservation!: () => void, observationEntered!: () => void, releaseList!: () => void, listEntered!: () => void;
  const observationGate = new Promise<void>(resolve => { releaseObservation = resolve; });
  const observationWaiting = new Promise<void>(resolve => { observationEntered = resolve; });
  const listGate = new Promise<void>(resolve => { releaseList = resolve; });
  const listWaiting = new Promise<void>(resolve => { listEntered = resolve; });
  let lists = 0, observations = 0;
  driver.daemonCommand = async () => {
    if (++lists === 2) { listEntered(); await listGate; }
    return { data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] };
  };
  driver.observeRaw = async () => {
    const count = ++observations;
    if (count === 1) { observationEntered(); await observationGate; }
    return { data: { pid: 12, window_id: 9, elements: [{ element_token: `e${count}`, role: "AXButton", title: "Play" }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] };
  };
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-pending-list-race", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  let second: ReturnType<typeof client.callTool> | undefined;
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const first = client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    await observationWaiting;
    second = client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    await listWaiting;
    releaseObservation();
    assert.equal((await first).isError, true, "an older result cannot become current while a newer request is pending");
    releaseList();
    assert.notEqual((await second).isError, true);
  } finally { releaseObservation(); releaseList(); await second?.catch(() => undefined); await client.close(); await server.close(); await driver.dispose(); }
});

test("sky observation preserves capture diagnostics and cannot act without an image", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  driver.daemonCommand = async () => ({ data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] });
  driver.observeRaw = async () => ({ data: { pid: 12, window_id: 9, warning: "empty_after_wakeup", screenshot_error: "screen_recording_not_granted", elements: [{ element_token: "e1", role: "AXButton" }] }, images: [] });
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-diagnostics", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const state = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    const body = JSON.parse((state.content as { text: string }[])[0]!.text);
    assert.equal(body.screenshot, null);
    assert.match(body.text, /empty_after_wakeup/);
    assert.match(body.text, /screen_recording_not_granted/);
    const action = await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0 } });
    assert.equal(action.isError, true);
    assert.match(JSON.stringify(action.content), /computer_observation_required/);
  } finally { await client.close(); await server.close(); await driver.dispose(); }
});

test("a late post-action refresh cannot replace a newer explicit observation", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let count = 0;
  const refs: string[] = [];
  driver.daemonCommand = async () => ({ data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] });
  driver.observeRaw = async () => {
    const id = ++count;
    if (id === 2) { started(); await gate; }
    return { data: { pid: 12, window_id: 9, elements: [{ element_token: `e${id}`, role: "AXButton", title: `item ${id}` }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] };
  };
  driver.actRaw = async (_name, args) => { refs.push(String(args.ref)); return { data: { effect: "confirmed" }, images: [] }; };
  driver.captureWindow = async () => ({ data: {}, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] });
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-refresh-race", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    const first = client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0 } });
    await entered;
    const newer = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    const body = JSON.parse((newer.content as { text: string }[])[0]!.text);
    const newIndex = Number((body.text as string).match(/^\[(\d+)\]/m)![1]);
    release();
    const firstResult = await first;
    assert.notEqual(firstResult.isError, true);
    assert.match(JSON.stringify(firstResult.content), /do not repeat this action automatically/);
    const second = await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: newIndex } });
    assert.notEqual(second.isError, true);
    assert.deepEqual(refs, ["e1", "e3"]);
  } finally { release(); await client.close(); await server.close(); await driver.dispose(); }
});

for (const held of ["action", "refresh"] as const) test(`a newer pending app lookup supersedes an earlier action ${held}`, async () => {
  const driver = new NativeProcessDriver(() => undefined);
  let releaseOld!: () => void, oldEntered!: () => void, releaseList!: () => void, listEntered!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const oldWaiting = new Promise<void>(resolve => { oldEntered = resolve; });
  const listGate = new Promise<void>(resolve => { releaseList = resolve; });
  const listWaiting = new Promise<void>(resolve => { listEntered = resolve; });
  let lists = 0, observations = 0;
  const refs: string[] = [];
  driver.daemonCommand = async () => {
    if (++lists === 2) { listEntered(); await listGate; }
    return { data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] };
  };
  driver.observeRaw = async () => {
    const count = ++observations;
    if (held === "refresh" && count === 2) { oldEntered(); await oldGate; }
    return { data: { pid: 12, window_id: 9, elements: [{ element_token: `e${count}`, role: "AXButton", title: "Play" }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] };
  };
  driver.actRaw = async (_name, args) => {
    refs.push(String(args.ref));
    if (held === "action" && refs.length === 1) { oldEntered(); await oldGate; }
    return { data: { effect: "confirmed" }, images: [] };
  };
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-action-pending-lookup", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  let action: ReturnType<typeof client.callTool> | undefined, newer: ReturnType<typeof client.callTool> | undefined;
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    assert.notEqual((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } })).isError, true);
    action = client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0 } });
    await oldWaiting;
    newer = client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    await listWaiting;
    releaseOld();
    const receipt = await action;
    assert.notEqual(receipt.isError, true);
    assert.equal(receipt.structuredContent?.observationRequired, true);
    assert.equal(receipt.structuredContent?.doNotRepeat, true);
    assert.deepEqual(refs, ["e1"]);
    assert.equal(observations, held === "action" ? 1 : 2, "a superseded action cannot launch another observation");
    releaseList();
    const state = await newer;
    assert.notEqual(state.isError, true, JSON.stringify(state.content));
    const stateText = JSON.parse((state.content as { text: string }[])[0]!.text).text as string;
    const index = Number(stateText.match(/^\[(\d+)\]/m)![1]);
    const click = await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: index } });
    assert.notEqual(click.isError, true);
    assert.deepEqual(refs, ["e1", held === "action" ? "e2" : "e3"]);
  } finally {
    releaseOld(); releaseList();
    await Promise.allSettled([...(action ? [action] : []), ...(newer ? [newer] : [])]);
    await client.close(); await server.close(); await driver.dispose();
  }
});

test("a fallback screenshot is not published after a newer sky lookup starts", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  let releaseShot!: () => void, shotEntered!: () => void, releaseList!: () => void, listEntered!: () => void;
  const shotGate = new Promise<void>(resolve => { releaseShot = resolve; });
  const shotWaiting = new Promise<void>(resolve => { shotEntered = resolve; });
  const listGate = new Promise<void>(resolve => { releaseList = resolve; });
  const listWaiting = new Promise<void>(resolve => { listEntered = resolve; });
  let lists = 0, observations = 0;
  driver.daemonCommand = async () => {
    if (++lists === 2) { listEntered(); await listGate; }
    return { data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] };
  };
  driver.observeRaw = async () => {
    const count = ++observations;
    if (count === 2) throw new Error("capture_timeout");
    return { data: { pid: 12, window_id: 9, elements: [{ element_token: `e${count}`, role: "AXButton", title: "Play" }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] };
  };
  driver.actRaw = async () => ({ data: { effect: "confirmed" }, images: [] });
  driver.capturePreview = async () => { shotEntered(); await shotGate; return { data: {}, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] }; };
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-fallback-pending-lookup", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  let action: ReturnType<typeof client.callTool> | undefined, newer: ReturnType<typeof client.callTool> | undefined;
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    assert.notEqual((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } })).isError, true);
    action = client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 0 } });
    await shotWaiting;
    newer = client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } });
    await listWaiting;
    releaseShot();
    const receipt = await action;
    assert.notEqual(receipt.isError, true);
    assert.equal(receipt.structuredContent?.doNotRepeat, true);
    assert.equal(receipt.content.some(part => part.type === "image"), false);
    releaseList();
    assert.notEqual((await newer).isError, true);
  } finally {
    releaseShot(); releaseList();
    await Promise.allSettled([...(action ? [action] : []), ...(newer ? [newer] : [])]);
    await client.close(); await server.close(); await driver.dispose();
  }
});

test("sky diffs preserve current indices, retire removed controls and allow a full refresh", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  let reads = 0;
  const refs: string[] = [];
  driver.daemonCommand = async () => ({ data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] });
  driver.observeRaw = async args => ({ data: { pid: 12, window_id: args.window_id ?? 9, elements: ++reads === 1
    ? [{ element_token: "a", role: "AXButton", title: "Alpha" }, { element_token: "b", role: "AXButton", title: "Beta" }]
    : [{ element_token: "a", role: "AXButton", title: "Updated" }, { element_token: "c", role: "AXButton", title: "Gamma" }] },
    images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] });
  driver.actRaw = async (_name, args) => { refs.push(String(args.ref)); return { data: { effect: "confirmed" }, images: [] }; };
  driver.captureWindow = async () => ({ data: {}, images: [] });
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-diff", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const observe = async (disableDiff = false) => {
      const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app", disableDiff } });
      assert.notEqual(result.isError, true);
      return JSON.parse((result.content as { text: string }[])[0]!.text).text as string;
    };
    assert.match(await observe(), /\[0\] Button "Alpha"[\s\S]*\[1\] Button "Beta"/);
    const changed = await observe();
    assert.match(changed, /removed indices: 1/);
    assert.match(changed, /\[0\] Button "Updated"[\s\S]*\[2\] Button "Gamma"/);
    assert.equal((await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 1 } })).isError, true);
    assert.notEqual((await client.callTool({ name: "sky_click", arguments: { app: "test.app", element_index: 2 } })).isError, true);
    assert.deepEqual(refs, ["c"]);
    assert.match(await observe(true), /\[0\] Button "Updated"[\s\S]*\[1\] Button "Gamma"/);
    const otherWindow = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app", window_id: 10 } });
    const otherText = JSON.parse((otherWindow.content as { text: string }[])[0]!.text).text as string;
    assert.doesNotMatch(otherText, /\(diff:/);
    assert.match(otherText, /\[0\] Button "Updated"[\s\S]*\[1\] Button "Gamma"/);
  } finally { await client.close(); await server.close(); await driver.dispose(); }
});

test("sky automatic window selection starts a fresh diff when the actual window or process changes", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  let pid = 12, windowId = 9;
  driver.daemonCommand = async () => ({ data: { apps: [{ pid, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] });
  driver.observeRaw = async () => ({ data: { pid, window_id: windowId, elements: [{ element_token: "e1", role: "AXButton", title: "Same title" }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] });
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-window-history", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const observe = async () => JSON.parse(((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } })).content as { text: string }[])[0]!.text).text as string;
    assert.match(await observe(), /\[0\] Button "Same title"/);
    assert.match(await observe(), /diff: 0 changed, 1 unchanged/);
    windowId = 10;
    const newWindow = await observe();
    assert.doesNotMatch(newWindow, /\(diff:/);
    assert.match(newWindow, /\[0\] Button "Same title"/);
    pid = 13;
    const newProcess = await observe();
    assert.doesNotMatch(newProcess, /\(diff:/);
    assert.match(newProcess, /\[0\] Button "Same title"/);
  } finally { await client.close(); await server.close(); await driver.dispose(); }
});

test("sky history expires after 60 seconds and evicts the least recently observed window", async context => {
  let now = 1_000;
  context.mock.method(performance, "now", () => now);
  const driver = new NativeProcessDriver(() => undefined);
  driver.daemonCommand = async () => ({ data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] });
  driver.observeRaw = async args => ({ data: { pid: 12, window_id: args.window_id ?? 1, elements: [{ element_token: "e1", role: "AXButton", title: "Play" }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] });
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-history-lifetime", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const observe = async (window_id: number): Promise<string> => {
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app", window_id } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return JSON.parse((result.content as { text: string }[])[0]!.text).text as string;
  };
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    assert.match(await observe(1), /\[0\] Button "Play"/);
    now += 59_999;
    assert.match(await observe(1), /diff: 0 changed, 1 unchanged/);
    now += 60_000;
    const expired = await observe(1);
    assert.doesNotMatch(expired, /\(diff:/);
    assert.match(expired, /\[0\] Button "Play"/);

    for (let window = 2; window <= 64; window++) { now++; await observe(window); }
    now++; assert.match(await observe(1), /diff: 0 changed, 1 unchanged/);
    now++; await observe(65);
    now++; assert.match(await observe(1), /diff: 0 changed, 1 unchanged/, "recently used window remains cached");
    now++;
    const evicted = await observe(2);
    assert.doesNotMatch(evicted, /\(diff:/, "least recently observed window starts with a full tree");
    assert.match(evicted, /\[0\] Button "Play"/);
  } finally { await client.close(); await server.close(); await driver.dispose(); context.mock.restoreAll(); }
});

test("sky reports changed control state even when its title and ref stay the same", async () => {
  const driver = new NativeProcessDriver(() => undefined);
  let selected = false, value = "0", actions = ["AXIncrement"];
  driver.daemonCommand = async () => ({ data: { apps: [{ pid: 12, bundleId: "test.app", name: "Fixture", running: true }] }, images: [] });
  driver.observeRaw = async () => ({ data: { pid: 12, window_id: 9, elements: [{ element_token: "e1", role: "AXSlider", title: "音量", value, selected, actions }] }, images: [{ mimeType: "image/jpeg", dataBase64: "/9j/2Q==" }] });
  const server = createComputerUseMcpServer(driver, { run: async (_tool, _args, operation) => await operation() });
  const client = new Client({ name: "sky-control-state", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const observe = async () => JSON.parse(((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.app" } })).content as { text: string }[])[0]!.text).text as string;
    assert.match(await observe(), /音量.*value="0".*unselected.*AXIncrement/);
    selected = true; value = "1"; actions = ["AXDecrement"];
    const changed = await observe();
    assert.match(changed, /diff: 1 changed/);
    assert.match(changed, /音量.*value="1".*selected.*AXDecrement/);
  } finally { await client.close(); await server.close(); await driver.dispose(); }
});
