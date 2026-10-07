/** 用真实附件存储验证 Desktop 的预览/打开路径，禁止虚拟路径和软链接越界。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { createSessionFile } from "../src/session/store.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-attachments-"));
try {
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const storage = new DesktopUserDataStore(path.join(root, "desktop"));
  await storage.initialize();
  const state = new DesktopStateStore(path.join(root, "state.json"));
  await state.load();
  const projects = new DesktopProjectService(state, storage, createFileConfigStore(root, { globalDir: root }));
  const project = await projects.createProject(workspace);
  const bytes = Buffer.from("%PDF-1.7\n");
  const attachment = await projects.saveAttachment(project, "report..pdf", "application/pdf", bytes);
  assert.equal(attachment.name, "report..pdf");
  assert.equal(attachment.path.includes(".."), false);
  assert.deepEqual(await readFile(projects.workspaceFile(project, attachment.path)), bytes);
  assert.equal((await projects.readWorkspaceFile(project, attachment.path)).path, attachment.path);
  assert.throws(() => projects.workspaceFile(project, "@attachments/../../escape.pdf"), /Invalid attachment path/u);
  await createSessionFile(workspace, "attachment-source", Buffer.from(JSON.stringify({ type: "user_message", content: "file", attachments: [attachment] }) + "\n"));
  const exported = await projects.buildSessionExport(project, "attachment-source", "biny");
  const source = path.join(root, "export.json");
  await writeFile(source, exported.content);
  const imported = await projects.importSessionFromFile(project, source);
  const bundle = JSON.parse((await projects.buildSessionExport(project, imported.sessionId, "biny")).content);
  const importedPath = bundle.events[0].attachments[0].path;
  assert.match(importedPath, /^@attachments\/import-[a-f0-9]{32}\/[^/]+$/u);
  assert.deepEqual(await readFile(projects.workspaceFile(project, importedPath)), bytes);
  assert.equal((await projects.readWorkspaceFile(project, importedPath)).path, importedPath);
  assert.throws(() => projects.workspaceFile(project, "@attachments/arbitrary/leaf.pdf"), /Invalid attachment path/u);

  const outside = path.join(root, "outside.pdf");
  await writeFile(outside, bytes);
  await symlink(outside, path.join(projects.attachmentsRoot(project), "link.pdf"));
  assert.throws(() => projects.workspaceFile(project, "@attachments/link.pdf"), /symbolic link/u);
  console.log("desktop attachment storage and path tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
