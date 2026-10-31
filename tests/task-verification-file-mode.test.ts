/** Real verification functions and filesystem; no Host/provider, permissions UI or process recovery is simulated. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  canReuseTaskVerification, captureTaskWorkspaceSnapshot, compareTaskWorkspaceSnapshots,
  fingerprintTaskArtifacts, fingerprintTaskVerificationDefinitions, readTaskVerificationContract,
  verifyTaskCandidate, type TaskCommandExecutor, type TaskVerificationContract
} from "../src/runtime/taskVerification.js";

const execute = promisify(execFile);
const posix = { skip: process.platform === "win32" ? "POSIX permission bits and executable-script behavior" : false };
const success = { result: { status: "completed", exitCode: 0 }, toolCallId: "check", eventReferences: ["check"] };
async function fixture(run: (root: string, contract: TaskVerificationContract) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-verification-file-mode-"));
  try {
    await writeFile(path.join(root, "artifact.sh"), '#!/bin/sh\nprintf "ok\\n"\n', { mode: 0o755 });
    await writeFile(path.join(root, "verify.sh"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(root, "outside.txt"), "unchanged", { mode: 0o644 });
    if (process.platform !== "win32") {
      await chmod(path.join(root, "artifact.sh"), 0o755);
      await chmod(path.join(root, "verify.sh"), 0o755);
      await chmod(path.join(root, "outside.txt"), 0o644);
    }
    const contract = readTaskVerificationContract({ objective: "deliver an executable artifact", checks: [{ id: "run", command: "./artifact.sh", definitionPaths: ["verify.sh"] }], artifactPaths: ["artifact.sh"], allowedRepairPaths: ["artifact.sh"] });
    await run(root, contract);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function verify(root: string, contract: TaskVerificationContract, executor: TaskCommandExecutor = { executeTaskCheck: async () => success }) {
  const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, []);
  const evidence = await verifyTaskCandidate({ workspaceRoot: root, ignore: [], taskRunId: "task", attemptId: "attempt", contract, definitionFingerprint, executor });
  return { definitionFingerprint, evidence };
}

test("passed real script evidence cannot be reused after its executable bit is removed", posix, async () => {
  await fixture(async (root, contract) => {
    const artifact = path.join(root, "artifact.sh");
    await chmod(artifact, 0o755);
    const { evidence, definitionFingerprint } = await verify(root, contract, { executeTaskCheck: async () => {
      const output = await execute(artifact, [], { cwd: root });
      return { ...success, result: { status: "completed", exitCode: 0, ...output } };
    } });
    assert.equal(evidence.status, "passed"); assert.equal(evidence.checks[0]?.stdout, "ok\n");
    await chmod(artifact, 0o644);
    await assert.rejects(execute(artifact, [], { cwd: root }), { code: "EACCES" });
    assert.equal(await canReuseTaskVerification({ evidence, definitionFingerprint, contract, workspaceRoot: root, ignore: [] }), false);
  });
});

for (const artifactPaths of [["artifact.sh"], ["."]]) {
  test(`artifact identity includes regular file permissions through ${artifactPaths.join()}`, posix, async () => {
    await fixture(async root => {
      const before = await fingerprintTaskArtifacts(root, artifactPaths, []);
      await chmod(path.join(root, "artifact.sh"), 0o644);
      assert.notEqual(await fingerprintTaskArtifacts(root, artifactPaths, []), before);
    });
  });
}

test("same-size unchanged bytes with changed read/write bits have distinct identities", posix, async () => {
  await fixture(async root => {
    const file = path.join(root, "outside.txt"); const beforeBytes = await readFile(file);
    const before = await fingerprintTaskArtifacts(root, ["outside.txt"], []);
    await chmod(file, 0o600);
    assert.deepEqual(await readFile(file), beforeBytes);
    assert.notEqual(await fingerprintTaskArtifacts(root, ["outside.txt"], []), before);
  });
});

test("definition-only chmod rejects verification before the executor is called", posix, async () => {
  await fixture(async (root, contract) => {
    const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, []);
    await chmod(path.join(root, "verify.sh"), 0o644);
    let calls = 0;
    const evidence = await verifyTaskCandidate({ workspaceRoot: root, ignore: [], taskRunId: "task", attemptId: "attempt", contract, definitionFingerprint, executor: { executeTaskCheck: async () => { calls++; return success; } } });
    assert.equal(evidence.status, "blocked"); assert.match(evidence.reason ?? "", /definition inputs changed/u); assert.equal(calls, 0);
  });
});

for (const file of ["artifact.sh", "verify.sh"]) {
  test(`chmod during successful checks blocks the changed ${file}`, posix, async () => {
    await fixture(async (root, contract) => {
      const { evidence } = await verify(root, contract, { executeTaskCheck: async () => { await chmod(path.join(root, file), 0o644); return success; } });
      assert.equal(evidence.checks[0]?.status, "passed"); assert.equal(evidence.status, "blocked");
      assert.match(evidence.reason ?? "", file === "artifact.sh" ? /Candidate artifacts changed/u : /definition inputs changed/u);
    });
  });
}

test("outside-allowlist chmod is captured and blocks checks without altering file bytes", posix, async () => {
  await fixture(async (root, contract) => {
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await chmod(path.join(root, "outside.txt"), 0o600);
    const after = await captureTaskWorkspaceSnapshot(root, []);
    const repairScope = compareTaskWorkspaceSnapshots(before, after, contract.allowedRepairPaths);
    assert.deepEqual(repairScope.changedPaths, ["outside.txt"]); assert.deepEqual(repairScope.violationPaths, ["outside.txt"]);
    assert.equal(await readFile(path.join(root, "outside.txt"), "utf8"), "unchanged");
    const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, []);
    let calls = 0;
    const evidence = await verifyTaskCandidate({ workspaceRoot: root, ignore: [], taskRunId: "task", attemptId: "attempt", contract, definitionFingerprint, repairScope, executor: { executeTaskCheck: async () => { calls++; return success; } } });
    assert.equal(evidence.status, "blocked"); assert.equal(calls, 0);
  });
});

test("allowed mode-only repairs remain admitted and can be verified", posix, async () => {
  await fixture(async (root, contract) => {
    await chmod(path.join(root, "artifact.sh"), 0o644);
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await chmod(path.join(root, "artifact.sh"), 0o755);
    const repairScope = compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, []), contract.allowedRepairPaths);
    assert.deepEqual(repairScope.changedPaths, ["artifact.sh"]); assert.deepEqual(repairScope.violationPaths, []);
    const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, []);
    const result = await verifyTaskCandidate({ workspaceRoot: root, ignore: [], taskRunId: "task", attemptId: "attempt", contract, definitionFingerprint, repairScope, executor: { executeTaskCheck: async () => { await execute(path.join(root, "artifact.sh")); return success; } } });
    assert.equal(result.status, "passed");
  });
});

test("unchanged permissions and content keep evidence reusable despite timestamp updates", async () => {
  await fixture(async (root, contract) => {
    const { evidence, definitionFingerprint } = await verify(root, contract);
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await utimes(path.join(root, "artifact.sh"), new Date(1000), new Date(2000));
    assert.equal(await canReuseTaskVerification({ workspaceRoot: root, ignore: [], evidence, contract, definitionFingerprint }), true);
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, []), []).changedPaths, []);
  });
});

test("content changes still invalidate identities and reveal out-of-scope edits", async () => {
  await fixture(async (root, contract) => {
    const { evidence, definitionFingerprint } = await verify(root, contract);
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await writeFile(path.join(root, "artifact.sh"), "changed content");
    assert.equal(await canReuseTaskVerification({ workspaceRoot: root, ignore: [], evidence, contract, definitionFingerprint }), false);
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, []), []).violationPaths, ["artifact.sh"]);
  });
});

test("ignored chmod remains outside the snapshot and unrelated check writes remain allowed", posix, async () => {
  await fixture(async (root, contract) => {
    await mkdir(path.join(root, "ignored")); const ignored = path.join(root, "ignored", "file.txt"); await writeFile(ignored, "x", { mode: 0o644 }); await chmod(ignored, 0o644);
    const before = await captureTaskWorkspaceSnapshot(root, ["ignored"]);
    await chmod(ignored, 0o600);
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, ["ignored"]), []).changedPaths, []);
    const { evidence } = await verify(root, contract, { executeTaskCheck: async () => { await chmod(path.join(root, "outside.txt"), 0o600); return success; } });
    assert.equal(evidence.status, "passed", "verification monitors declared artifacts/definitions, not the entire workspace");
  });
});

test("legacy content-only artifact fingerprints fail closed instead of being reused", async () => {
  await fixture(async (root, contract) => {
    const { evidence, definitionFingerprint } = await verify(root, contract);
    const file = path.join(root, "artifact.sh"); const metadata = await lstat(file); const bytes = await readFile(file);
    const legacy = createHash("sha256").update(`file\0artifact.sh\0${String(metadata.size)}\0`).update(bytes).update("\0").digest("hex");
    assert.equal(await canReuseTaskVerification({ workspaceRoot: root, ignore: [], evidence: { ...evidence, artifactFingerprint: legacy }, contract, definitionFingerprint }), false);
  });
});

test("pre-aborted verification remains cancelled without dispatch", async () => {
  await fixture(async (root, contract) => {
    const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, []);
    const evidence = await verifyTaskCandidate({ workspaceRoot: root, ignore: [], taskRunId: "task", attemptId: "attempt", contract, definitionFingerprint, signal: AbortSignal.abort(), executor: { executeTaskCheck: async () => assert.fail("must not dispatch") } });
    assert.equal(evidence.status, "cancelled");
  });
});

for (const bit of [0o1000, 0o2000, 0o4000]) {
  test(`regular-file special permission bit ${bit.toString(8)} is part of identity`, posix, async () => {
    await fixture(async root => {
      const file = path.join(root, "outside.txt");
      await chmod(file, 0o644);
      const before = await fingerprintTaskArtifacts(root, ["outside.txt"], []);
      const snapshot = await captureTaskWorkspaceSnapshot(root, []);
      await chmod(file, 0o644 | bit);
      assert.equal((await lstat(file)).mode & 0o7777, 0o644 | bit, "the real filesystem must retain the tested permission bit");
      assert.notEqual(await fingerprintTaskArtifacts(root, ["outside.txt"], []), before);
      assert.deepEqual(compareTaskWorkspaceSnapshots(snapshot, await captureTaskWorkspaceSnapshot(root, []), []).violationPaths, ["outside.txt"]);
    });
  });
}

test("legacy content-only workspace snapshots fail closed and are never silently migrated", async () => {
  await fixture(async root => {
    const legacy: Record<string, string> = {};
    for (const file of ["artifact.sh", "verify.sh", "outside.txt"]) {
      legacy[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
    }
    const snapshot = await captureTaskWorkspaceSnapshot(root, []);
    const delta = compareTaskWorkspaceSnapshots(legacy, snapshot, ["artifact.sh"]);
    assert.deepEqual(delta.changedPaths, ["artifact.sh", "outside.txt", "verify.sh"]);
    assert.deepEqual(delta.violationPaths, ["outside.txt", "verify.sh"]);
    assert.deepEqual(compareTaskWorkspaceSnapshots(snapshot, await captureTaskWorkspaceSnapshot(root, []), []).changedPaths, []);
  });
});
