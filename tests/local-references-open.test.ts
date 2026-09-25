/** CLI open 先解析权限与对象，再把 URI 和项目交给桌面应用。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localReferenceProjectId } from "../src/session/localReferences.js";
import { referenceOpenCommand } from "../src/cli/commands/references.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-ref-open-"));
const project = path.join(root, "project");
try {
  await mkdir(project);
  const calls: Array<{ command: string; args: string[] }> = [];
  await referenceOpenCommand(project, `biny://project/${localReferenceProjectId(project)}`, {
    platform: "darwin", launch: async (command, args) => { calls.push({ command, args }); }
  });
  assert.deepEqual(calls, [{ command: "open", args: ["-n", "-a", "Biny", "--args",
    `--biny-ref=biny://project/${localReferenceProjectId(project)}`, `--biny-project=${localReferenceProjectId(project)}`] }]);
  await assert.rejects(referenceOpenCommand(project, "biny://file/..%2Fsecret", {
    platform: "darwin", launch: async () => { throw new Error("must not launch"); }
  }));
  console.log("local reference open tests passed");
} finally { await rm(root, { recursive: true, force: true }); }
