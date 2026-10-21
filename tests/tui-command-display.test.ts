import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { createRuntimeHostFactory } from "../src/runtime/host/runtimeFactory.js";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TUI, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { buildMcpCard, buildSubagentTasksCard, buildTextCard } from "../src/runtime/commandCards.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionGoalStore } from "../src/runtime/SessionGoalStore.js";
import { BinyTui } from "../src/tui/app.js";
import { renderCardLines } from "../src/tui/components/cards.js";
import { SelectDialog } from "../src/tui/components/dialogs.js";
import { StatusIndicatorComponent } from "../src/tui/components/chrome.js";

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/gu, "");
function ui(): TUI {
  const terminal: Terminal = {
    start: () => undefined, stop: () => undefined, drainInput: async () => undefined,
    write: () => undefined, columns: 80, rows: 24, kittyProtocolActive: false,
    moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
    clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
    setTitle: () => undefined, setProgress: () => undefined
  };
  return new TUI(terminal);
}

test("TUI command results stay in the transcript and goal controls show only meaningful state", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tui-commands-"));
  const configDir = path.join(root, "config");
  await saveConfig(root, {
    ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  }, { globalDir: configDir });
  const host = await createInteractiveAgentHost(root, { configStore: createFileConfigStore(root, { globalDir: configDir }) });
  const terminalUi = ui();
  const app = new BinyTui(terminalUi, root);
  const factory = createRuntimeHostFactory(root, () => ({ configStore: createFileConfigStore(root, { globalDir: configDir }) }));
  const server = await startRuntimeHost(root, async () => host, { configDir, createRuntime: factory });
  server["businessComposition"].stop();
  const transport = await connectRuntimeHost(root, { configDir, surface: "tui" });
  assert.ok(transport);
  app["runtime"] = transport;
  app["runtimeSnapshot"] = host.runtime.getSnapshot();
  try {
    app["setAutocompleteProvider"]([{ name: "review", description: "Review code changes" }], root);
    app["editor"].setText("Review this draft");
    const overlays = t.mock.method(terminalUi, "showOverlay");
    await app["handleSlashCommand"]("/skills");
    const picker = overlays.mock.calls.at(-1)?.arguments[0];
    assert.ok(picker instanceof SelectDialog);
    picker.handleInput("review");
    picker.handleInput("\r");
    assert.equal(app["editor"].getExpandedText(), "/skill:review Review this draft");
    assert.equal(app["overlay"], undefined);
    assert.deepEqual(app.tuiState.transcript.committed, [], "skill selection must not submit a message or a report");
    await app["handleSlashCommand"]("/skills");
    const cancelled = overlays.mock.calls.at(-1)?.arguments[0];
    assert.ok(cancelled instanceof SelectDialog);
    cancelled.handleInput("\u001b");
    assert.equal(app["editor"].getExpandedText(), "/skill:review Review this draft");
    overlays.mock.restore();
    app["editor"].setText("");
    const subagents = t.mock.method(terminalUi, "showOverlay");
    await app["handleSlashCommand"]("/subagent");
    const actions = subagents.mock.calls.at(-1)?.arguments[0];
    assert.ok(actions instanceof SelectDialog);
    actions.handleInput("\u001b[B");
    actions.handleInput("\u001b[B");
    actions.handleInput("\r");
    assert.equal(app["editor"].getExpandedText(), "/subagent start ");
    assert.deepEqual(app.tuiState.transcript.committed, [], "starting a subagent from the menu must wait for its task");
    subagents.mock.restore();
    app["editor"].setText("");
    await app["handleSlashCommand"]("/goal");
    assert.equal(app["overlay"], undefined, "reading a goal must not cover conversation history");
    await app["handleSlashCommand"]("/goal set Improve command display");
    await app["handleSlashCommand"]("/goal pause");
    const status = plain(app["status"].render(80).join("\n"));
    assert.match(status, /Goal.*paused.*Improve command display/iu);
    assert.equal(app["status"].render(80).length, 1);
    const transcript = plain(app["chatContainer"].render(80).join("\n"));
    assert.doesNotMatch(transcript, /workspaceId|sessionId|goalId|generation|revision|createdAt/u);
    await app["handleSlashCommand"]("/goal clear");
    assert.doesNotMatch(plain(app["status"].render(80).join("\n")), /Improve command display/u);
    for (const command of ["/tasks", "/automation", "/capabilities", "/subagent status", "/soul show"]) {
      await app["handleSlashCommand"](command);
      assert.equal(app["overlay"], undefined, `${command} must not open a blocking report`);
      assert.equal(app.tuiState.transcript.committed.at(-1)?.kind, "card", command);
    }
    const task = host.commands.taskRuns.create({ task: { prompt: "Inspect command behavior" } });
    const automation = host.commands.automationStore.create({
      name: "Daily review", triggerType: "interval", schedule: { intervalMs: 3_600_000 },
      executionTemplate: { prompt: "Review the workspace" }
    });
    host.commands.automationStore.pause(automation.automationId);
    const graph = host.commands.graphs.createSupervisedGraph({ supervisorSessionId: "supervisor", nodes: [{ nodeKey: "inspect", prompt: "Inspect command behavior" }] });
    for (const entry of [
      { command: "/tasks", text: "Inspect command behavior", id: task.taskRunId },
      { command: "/automation", text: "Daily review", id: automation.automationId },
      { command: `/graph inspect ${graph.graphId}`, text: "0/1 nodes completed", id: graph.graphId }
    ]) {
      await app["handleSlashCommand"](entry.command);
      const card = app.tuiState.transcript.committed.at(-1);
      assert.ok(card?.kind === "card");
      const summary = plain(renderCardLines({ ...card, command: "" }, false, 80).join("\n"));
      assert.ok(summary.includes(entry.text));
      assert.ok(!summary.includes(entry.id), "operational IDs belong in details");
      assert.ok(plain(renderCardLines({ ...card, command: "" }, true, 80).join("\n")).includes(entry.id));
      assert.equal(app["overlay"], undefined);
    }
    const sessionId = host.runtime.getSnapshot().info.sessionId;
    const authority = await RuntimeEventAuthority.open(root);
    const otherStore = await SessionGoalStore.open(root, authority);
    try {
      const get = host.commands.sessionGoals.get.bind(host.commands.sessionGoals);
      const reads = t.mock.method(host.commands.sessionGoals, "get", get);
      for (let index = 0; index < 50; index += 1) host.runtime.getSnapshot();
      assert.equal(reads.mock.callCount(), 0, "unchanged runtime snapshots must reuse the goal projection");
      const changed: string[] = [];
      const unsubscribe = host.runtime.subscribe((update) => {
        if (update.snapshot.sessionGoal) changed.push(update.snapshot.sessionGoal.status);
      });
      try {
        otherStore.set(sessionId, "Goal changed by another session handle");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(changed, ["active"], "goal changes on another handle must publish the current session projection");
        assert.deepEqual(host.runtime.getSnapshot().sessionGoal, { objective: "Goal changed by another session handle", status: "active" });
        assert.equal(reads.mock.callCount(), 1);
        otherStore.pause(sessionId);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(host.runtime.getSnapshot().sessionGoal?.status, "paused");
        otherStore.set("unrelated-session", "Unrelated goal");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(reads.mock.callCount(), 2, "other sessions must not invalidate this session's projection");
        await transport.startDraft();
        assert.equal(transport.getSnapshot().sessionGoal, undefined, "new chats must not inherit a previous goal");
      } finally {
        unsubscribe();
        reads.mock.restore();
      }
      otherStore.clear("unrelated-session");
      const currentSession = host.runtime.getSnapshot().info.sessionId;
      otherStore.set(currentSession, "Goal delivered through Host");
      otherStore.pause(currentSession);
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        const client = await connectRuntimeHost(root, { configDir, surface: "tui", handshakeTimeoutMs: 5_000 });
        assert.ok(client);
        try {
          assert.deepEqual(client.getSnapshot().sessionGoal, { objective: "Goal delivered through Host", status: "paused" });
          const result = await client.executeCommand("/goal", "tui");
          assert.ok(result?.card);
          const output = plain(renderCardLines({ id: "goal", kind: "card", command: "/goal", title: result.card.title, data: result.card }, true, 100).join("\n"));
          assert.match(output, /Goal delivered through Host/u);
          assert.doesNotMatch(output, /workspaceId|sessionId|goalId|generation|revision|createdAt/u);
          let stop = (): void => undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const cleared = new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Host goal clear notification timed out")), 5_000);
            stop = client.subscribe((update) => {
              if (update.snapshot.info.sessionId === currentSession && !update.snapshot.sessionGoal) resolve();
            });
          });
          try {
            otherStore.clear(currentSession);
            await cleared;
            assert.equal(client.getSnapshot().sessionGoal, undefined);
          } finally {
            stop();
            clearTimeout(timer);
          }
        } finally {
          await client.close();
        }
      } finally {
        await server.close();
      }
    } finally {
      otherStore.close();
      authority.close();
    }
  } finally {
    app["closeOverlay"]();
    app["status"].dispose();
    await transport.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("long goals leave running and MCP failure states visible in the fixed status row", () => {
  const status = new StatusIndicatorComponent(ui());
  try {
    status.setGoal({ objective: "Long objective ".repeat(100), status: "active" });
    status.setState("thinking");
    status.setMcpStatus({ message: "MCP failed", tone: "warning", loading: false });
    const output = status.render(90);
    assert.equal(output.length, 1);
    assert.match(plain(output[0]!), /Goal active.*Working.*esc to interrupt.*MCP failed/iu);
    assert.ok(visibleWidth(output[0]!) <= 90);
  } finally {
    status.dispose();
  }
});

test("MCP failures remain visible ahead of a long server directory", () => {
  const servers = Array.from({ length: 12 }, (_, index) => ({
    name: `server-${index}`, transport: "stdio" as const, command: "server", enabled: true,
    connected: true, toolNames: [], promptNames: [], hasResources: false
  }));
  const data = buildMcpCard([...servers, { ...servers[0]!, name: "broken", connected: false, lastError: "Connection refused" }]);
  const output = plain(renderCardLines({ id: "mcp", kind: "card", command: "/mcp", title: data.title, data }, false, 80).join("\n"));
  assert.match(output, /Connection refused.*\/mcp reconnect broken/u);
});

test("retired goal subscriptions cannot remove replacement listeners or receive queued notifications", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-goal-listeners-"));
  const authority = await RuntimeEventAuthority.open(root);
  const retired = await SessionGoalStore.open(root, authority);
  const current = await SessionGoalStore.open(root, authority);
  try {
    const stop = retired.subscribe(() => assert.fail("closed stores must not receive notifications"));
    retired.close();
    const changes: string[] = [];
    current.subscribe((sessionId) => changes.push(sessionId));
    stop();
    current.set("current-session", "Observe a goal change");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(changes, ["current-session"]);
    current.pause("current-session");
    current.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(changes, ["current-session"], "closing a handle must cancel queued delivery");
  } finally {
    retired.close();
    current.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("subagent cards lead with task and status while keeping operational identifiers in details", () => {
  const data = buildSubagentTasksCard([{
    taskId: "task-internal-123", parentRunId: "parent-internal-456", task: "Inspect failing tests",
    agent: "reviewer", status: "failed", error: "Build output is missing",
    createdAt: "2026-10-16T00:00:00.000Z", deadline: "2026-10-16T00:02:00.000Z"
  }]);
  const item = { id: "card", kind: "card" as const, command: "/subagent status", title: data.title, data };
  const collapsed = plain(renderCardLines(item, false, 80).join("\n"));
  assert.match(collapsed, /Inspect failing tests/u);
  assert.match(collapsed, /failed.*reviewer/u);
  assert.match(collapsed, /Build output is missing/u);
  assert.doesNotMatch(collapsed, /task-internal|parent-internal|deadline/u);
  assert.match(plain(renderCardLines(item, true, 100).join("\n")), /task-internal-123/u);
});

test("command cards wrap long results, bound their summary and retain the full expanded output", () => {
  const content = Array.from({ length: 60 }, (_, index) => `Result ${index + 1}: 中文结果 ${"details ".repeat(15)}`).join("\n");
  const data = buildTextCard("Review", content);
  const item = { id: "review", kind: "card" as const, command: "/review", title: data.title, data };
  for (const width of [1, 8, 10, 30, 80, 120]) {
    const summary = renderCardLines(item, false, width);
    assert.ok(summary.length <= 12, `summary at ${width} columns: ${summary.length} rows`);
    for (const line of summary) assert.ok(visibleWidth(line) <= width);
    if (width >= 10) assert.match(plain(summary.join("\n")), /ctrl\+o|…/u);
  }
  const expanded = renderCardLines(item, true, 40);
  for (const line of expanded) assert.ok(visibleWidth(line) <= 40);
  assert.match(plain(expanded.join("\n")), /Result 60:/u);
  assert.doesNotMatch(plain(expanded.join("\n")), /omitted/u);
});
