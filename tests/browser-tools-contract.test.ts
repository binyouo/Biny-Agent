import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrowserTools } from "../src/tools/browser.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";

test("built-in browser wait and file tools preserve project/session identity and workspace boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-contract-"));
  const endpoint = { endpoint: path.join(root, "browser.sock"), token: "test-only", projectId: "project-a" };
  const requests: Array<{ method: string; args: Record<string, unknown> }> = [];
  const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; args: Record<string, unknown> };
      requests.push({ method: request.method, args: request.args });
      const result = request.method === "locator_read" ? 2
      : request.method === "cdp_agent" ? { cssContentSize: { width: 1280, height: 720 } }
      : request.method === "list_profiles" ? [{ id: "chrome:Default", appName: "Google Chrome", profileName: "Default" }]
      : request.method === "profile_history" ? [{ url: "https://example.org/visited", title: "Visited page", visitedAt: "2026-02-01T00:00:00.000Z" }]
      : request.method === "locator_action" ? { url: "https://example.org/after-action", title: "After action" }
        : request.method === "dom_snapshot" ? { snapshotId: "00000000-0000-4000-8000-000000000001", url: "https://example.org/", title: "Page", elements: [] }
          : request.method === "dom_action" || request.method === "cua" ? { url: "https://example.org/after-action", title: "After action" }
        : request.method === "upload" ? { count: 1 }
      : request.method === "wait" ? true
        : request.method === "close" ? { closed: true }
          : request.method === "float" ? { floating: request.args.action === "show" }
                : request.method === "dialog" ? { watching: true, dialog: null }
                  : request.method === "clipboard" ? request.args.action === "read" ? request.args.includeImage === true
                    ? { text: "private clipboard contents", truncated: false, hasImage: true, imageStatus: "available", imageData: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") }
                    : { text: "private clipboard contents", truncated: false } : { written: true }
                    : request.method === "set_checked" ? { checked: true }
              : request.method === "select_option" ? { values: ["ca"] }
          : { mimeType: ["download", "download_media"].includes(request.method) ? "application/octet-stream" : "application/pdf", data: Buffer.from(["download", "download_media"].includes(request.method) ? "downloaded" : "%PDF-fixture").toString("base64") };
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.endpoint, () => { server.off("error", reject); resolve(); });
  });
  try {
    await writeFile(path.join(root, "upload.txt"), "upload body");
    const tools = createBrowserTools(endpoint, { workspaceRoot: root, ignore: [] });
    const returnedImages: Array<{ type: "image"; data: string; mimeType: string }> = [];
    const execute = async (name: string, args: unknown): Promise<unknown> => {
      const tool = tools.find(item => item.name === name)!;
      const execution = await tool.resolveExecution(tool.schema.parse(args));
      assert.ok(!("isError" in execution), `${name} execution should be ready`);
      return await execution.execute({ toolCallId: name, operationId: `${name}-operation`, sessionId: "agent-session", onImage: image => { returnedImages.push(image); return true; } });
    };

    const wait = await execute("BrowserWait", { selector: "label=Email", state: "visible", timeoutMs: 8000 });
    assert.equal(wait, true);
    await execute("BrowserBack", {});
    await execute("BrowserForward", {});
    await execute("BrowserReload", {});
    assert.deepEqual(await execute("BrowserClose", {}), { closed: true });
    await execute("BrowserScroll", { deltaX: 0, deltaY: 600 });
    assert.deepEqual(await execute("BrowserSelectOption", { selector: "#country", values: ["ca"] }), { values: ["ca"] });
    assert.deepEqual(await execute("BrowserSetChecked", { selector: "#accept", checked: true }), { checked: true });
    await execute("BrowserViewport", { action: "reset" });
    await execute("BrowserEval", { code: "document.title" });
    assert.deepEqual(await execute("BrowserCDP", { method: "Page.getLayoutMetrics" }), { cssContentSize: { width: 1280, height: 720 } });
    await execute("BrowserDialogStatus", { action: "get" });
    await execute("BrowserDialogRespond", { action: "dismiss" });
    assert.deepEqual(await execute("BrowserUpload", { selector: "input[type=file]", paths: ["upload.txt"] }), { count: 1 });
    await execute("BrowserDownload", { url: "https://example.org/file.bin", path: "download.bin" });
    await execute("BrowserDownload", { selector: "video", path: "media.mp4" });
    await execute("BrowserExport", { format: "pdf", path: "page.pdf" });
    await execute("BrowserExport", { format: "google-docx", path: "document.docx" });
    assert.equal(await execute("BrowserLocatorRead", { steps: [{ m: "getByRole", role: "button", name: "Save" }], action: { m: "count" } }), 2);
    assert.deepEqual(await execute("BrowserLocatorAction", { steps: [{ m: "getByRole", role: "button", name: "Save" }, { m: "nth", index: 1 }], action: { m: "click" } }), { url: "https://example.org/after-action", title: "After action" });
    await execute("BrowserDOMSnapshot", {});
    await execute("BrowserDOMAction", { snapshotId: "00000000-0000-4000-8000-000000000001", ref: "e1", action: { m: "click" } });
    await execute("BrowserCUA", { action: "click", x: 320, y: 210 });
    await execute("BrowserDialogAutoReply", { action: "arm", behavior: "accept", text: "sensitive prompt response" });
    await execute("BrowserDialogAutoReply", { action: "stop" });
    assert.deepEqual(await execute("BrowserClipboardRead", {}), { text: "private clipboard contents", truncated: false });
    assert.deepEqual(await execute("BrowserClipboardRead", { includeImage: true }), {
      text: "private clipboard contents", truncated: false, hasImage: true, imageStatus: "available", imageReturned: true
    });
    assert.deepEqual(returnedImages.at(-1), { type: "image", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") });
    assert.deepEqual(await execute("BrowserClipboardWrite", { text: "private clipboard write" }), { written: true });
    assert.deepEqual(await execute("BrowserTabFloat", { action: "show" }), { floating: true });
    assert.deepEqual(await execute("BrowserTabFloat", { action: "hide" }), { floating: false });
    assert.deepEqual(await execute("BrowserListProfiles", {}), [{ id: "chrome:Default", appName: "Google Chrome", profileName: "Default" }]);
    assert.deepEqual(await execute("BrowserProfileHistory", { profileId: "chrome:Default", query: "visited", limit: 5 }), [
      { url: "https://example.org/visited", title: "Visited page", visitedAt: "2026-02-01T00:00:00.000Z" }
    ]);

    assert.deepEqual(requests.map(request => request.method), ["wait", "back", "forward", "reload", "close", "scroll", "select_option", "set_checked", "viewport", "evaluate", "cdp_agent", "dialog", "dialog", "upload", "download", "download_media", "export", "export_gsuite", "locator_read", "locator_action", "dom_snapshot", "dom_action", "cua", "dialog_auto", "dialog_auto", "clipboard", "clipboard", "clipboard", "float", "float", "list_profiles", "profile_history"]);
    assert.deepEqual(requests[0]!.args, { selector: "label=Email", state: "visible", timeoutMs: 8000, projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[5]!.args, { x: 0, y: 600, projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[6]!.args, { selector: "#country", values: ["ca"], projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[7]!.args, { selector: "#accept", checked: true, projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[11]!.args, { action: "get", projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[13]!.args, {
      selector: "input[type=file]", files: [{ name: "upload.txt", mimeType: "text/plain", data: Buffer.from("upload body").toString("base64") }], projectId: "project-a", sessionId: "agent-session"
    });
    assert.deepEqual(requests[14]!.args, { url: "https://example.org/file.bin", projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[15]!.args, { selector: "video", projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[16]!.args, { format: "pdf", projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[17]!.args, { format: "docx", projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[18]!.args, { steps: [{ m: "getByRole", role: "button", name: "Save" }], action: { m: "count" }, projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[19]!.args, { steps: [{ m: "getByRole", role: "button", name: "Save" }, { m: "nth", index: 1 }], action: { m: "click" }, projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[20]!.args, { projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[21]!.args, { snapshotId: "00000000-0000-4000-8000-000000000001", ref: "e1", action: { m: "click" }, projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[22]!.args, { action: { action: "click", x: 320, y: 210 }, projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[23]!.args, { action: "arm", behavior: "accept", text: "sensitive prompt response", projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[24]!.args, { action: "stop", projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[10]!.args, { method: "Page.getLayoutMetrics", params: {}, projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[25]!.args, { action: "read", includeImage: false, projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[26]!.args, { action: "read", includeImage: true, projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[27]!.args, { action: "write", text: "private clipboard write", projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[28]!.args, { action: "show", projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[29]!.args, { action: "hide", projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[30]!.args, { projectId: "project-a", sessionId: "agent-session" });
    assert.deepEqual(requests[31]!.args, { profileId: "chrome:Default", query: "visited", limit: 5, projectId: "project-a", sessionId: "agent-session" });
    const profileHistory = tools.find(item => item.name === "BrowserProfileHistory")!;
    assert.equal(profileHistory.risk, "read");
    assert.equal(profileHistory.exposure, "model-only");
    assert.match(profileHistory.description, /explicitly asks/u);
    assert.match(profileHistory.promptGuidelines?.join(" ") ?? "", /user identifies/u);
    assert.equal((await profileHistory.resolveExecution(profileHistory.schema.parse({ profileId: "chrome:Default" }))).retrySafety, "safe");
    assert.equal(tools.find(item => item.name === "BrowserListProfiles")!.exposure, "model-only");
    assert.equal(tools.find(item => item.name === "BrowserClipboardRead")!.risk, "read");
    assert.equal(tools.find(item => item.name === "BrowserClipboardWrite")!.risk, "write");
    assert.equal(tools.find(item => item.name === "BrowserClipboardRead")!.exposure, "model-only");
    assert.equal(tools.find(item => item.name === "BrowserClipboardWrite")!.exposure, "model-only");
    assert.equal(tools.find(item => item.name === "BrowserClipboardRead")!.resolveExecution!({}).retrySafety, "safe");
    const cdp = tools.find(item => item.name === "BrowserCDP")!;
    assert.equal(cdp.risk, "execute");
    assert.equal(cdp.exposure, "model-only");
    assert.equal(cdp.schema.parse({ method: "DOM.setFileInputFiles", params: { files: ["/etc/passwd"] } }).method, "DOM.setFileInputFiles");
    assert.equal(cdp.schema.parse({ method: "Page.getLayoutMetrics", params: { arbitrary: true } }).method, "Page.getLayoutMetrics");
    assert.throws(() => cdp.schema.parse({ method: "Page", params: {} }));
    assert.throws(() => cdp.schema.parse({ method: "Page.getLayoutMetrics", params: { value: "x".repeat(16 * 1024) } }));
    assert.throws(() => cdp.schema.parse({ method: "Emulation.setEmulatedMedia", params: { features: Array.from({ length: 32 }, () => ({ name: "n".repeat(512), value: "v".repeat(512) })) } }));
    const floatTool = tools.find(item => item.name === "BrowserTabFloat")!;
    assert.equal(floatTool.risk, "execute");
    assert.equal((await floatTool.resolveExecution(floatTool.schema.parse({ action: "show" }))).retrySafety, "unsafe");
    assert.throws(() => floatTool.schema.parse({ action: "toggle" }));
    const clipboardWrite = tools.find(item => item.name === "BrowserClipboardWrite")!;
    assert.throws(() => clipboardWrite.schema.parse({ text: "x".repeat(100_001) }));
    const clipboardWriteExecution = await clipboardWrite.resolveExecution(clipboardWrite.schema.parse({ text: "private clipboard write" }));
    assert.ok(!("isError" in clipboardWriteExecution));
    assert.deepEqual(clipboardWriteExecution.display?.detail, { action: "write", text: "[redacted before display]" });
    assert.equal(tools.find(item => item.name === "BrowserLocatorRead")!.risk, "read");
    assert.equal(tools.find(item => item.name === "BrowserLocatorAction")!.risk, "execute");
    assert.equal(tools.find(item => item.name === "BrowserDOMSnapshot")!.risk, "read");
    assert.equal(tools.find(item => item.name === "BrowserDOMAction")!.risk, "execute");
    assert.equal(tools.find(item => item.name === "BrowserCUA")!.risk, "execute");
    const autoReply = tools.find(item => item.name === "BrowserDialogAutoReply")!;
    assert.equal(autoReply.risk, "execute");
    assert.throws(() => autoReply.schema.parse({ action: "arm", behavior: "dismiss", text: "ignored" }));
    const autoReplyExecution = await autoReply.resolveExecution(autoReply.schema.parse({ action: "arm", behavior: "accept", text: "sensitive prompt response" }));
    assert.deepEqual((autoReplyExecution as { display?: { detail?: unknown } }).display?.detail, { action: "arm", behavior: "accept", text: "[redacted before display]" });
    assert.throws(() => tools.find(item => item.name === "BrowserCUA")!.schema.parse({ action: "click", x: 9000, y: 1 }));
    assert.throws(() => tools.find(item => item.name === "BrowserDOMAction")!.schema.parse({ snapshotId: "stale", ref: "e1", action: { m: "click" } }));
    for (const [name, args] of [
      ["BrowserDOMAction", { snapshotId: "00000000-0000-4000-8000-000000000001", ref: "e1", action: { m: "type", text: "private browser text" } }],
      ["BrowserCUA", { action: "type", text: "private browser text" }]
    ] as const) {
      const tool = tools.find(item => item.name === name)!;
      const execution = await tool.resolveExecution(tool.schema.parse(args));
      assert.ok(!("isError" in execution));
      assert.doesNotMatch(JSON.stringify(execution.display?.detail), /private browser text/u);
      assert.match(JSON.stringify(execution.display?.detail), /redacted before display/u);
    }
    assert.equal((await readFile(path.join(root, "download.bin"))).toString(), "downloaded");
    assert.equal((await readFile(path.join(root, "media.mp4"))).toString(), "downloaded");
    assert.equal((await readFile(path.join(root, "page.pdf"))).toString(), "%PDF-fixture");
    assert.equal((await readFile(path.join(root, "document.docx"))).toString(), "%PDF-fixture");
    const download = tools.find(item => item.name === "BrowserDownload")!;
    assert.throws(() => download.schema.parse({ path: "invalid.bin" }), /必须且只能/u);
    assert.throws(() => download.schema.parse({ url: "https://example.org/a", selector: "video", path: "invalid.bin" }), /必须且只能/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatched browser actions report an unknown outcome when cancellation loses the response", async t => {
  for (const [name, args] of [
    ["BrowserClose", {}],
    ["BrowserSelectOption", { selector: "#country", values: ["ca"] }],
    ["BrowserSetChecked", { selector: "#accept", checked: true }],
    ["BrowserLocatorAction", { steps: [{ m: "getByRole", role: "button", name: "Save" }], action: { m: "click" } }],
    ["BrowserDOMAction", { snapshotId: "00000000-0000-4000-8000-000000000001", ref: "e1", action: { m: "click" } }],
    ["BrowserCUA", { action: "click", x: 320, y: 210 }],
    ["BrowserClipboardWrite", { text: "clipboard content" }],
    ["BrowserCDP", { method: "Page.getLayoutMetrics" }],
    ["BrowserTabFloat", { action: "show" }]
  ] as const) {
    await t.test(name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-cancel-"));
      const endpoint = { endpoint: path.join(root, "browser.sock"), token: "test-only", projectId: "project-a" };
      let resolveRequest!: () => void;
      const received = new Promise<void>(resolve => { resolveRequest = resolve; });
      const server = net.createServer(socket => {
        socket.on("data", () => resolveRequest());
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint.endpoint, () => { server.off("error", reject); resolve(); });
      });
      try {
        const tool = createBrowserTools(endpoint).find(item => item.name === name)!;
        const execution = await tool.resolveExecution(tool.schema.parse(args));
        assert.ok(!("isError" in execution));
        const controller = new AbortController();
        const pending = execution.execute({ toolCallId: name, operationId: `${name}-cancel`, sessionId: "agent-session", signal: controller.signal });
        await received;
        controller.abort();
        await assert.rejects(pending, error => error instanceof ToolOutcomeUnknownError && error.reason === "cancelled");
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
