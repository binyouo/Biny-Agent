/** Full verification module and real local files/processes; not a Host or restart integration test. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  canReuseTaskVerification, captureTaskWorkspaceSnapshot, compareTaskWorkspaceSnapshots,
  fingerprintTaskArtifacts, fingerprintTaskVerificationDefinitions, readTaskVerificationContract,
  verifyTaskCandidate, type TaskCommandExecutor, type TaskVerificationContract
} from "../src/runtime/taskVerification.js";

const execute = promisify(execFile);
const links = { skip: process.platform === "win32" ? "Real POSIX symlinks; Windows link privileges/junctions are not covered" : false };
const success = { result: { status: "completed", exitCode: 0 }, toolCallId: "check", eventReferences: ["check"] };
async function fixture(run: (root: string, outer: string) => Promise<void>) {
  const outer = await mkdtemp(path.join(tmpdir(), "biny-verification-links-"));
  const root = path.join(outer, "workspace");
  try {
    await mkdir(root); await mkdir(path.join(root, "dist")); await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "artifact.txt"), "candidate");
    await writeFile(path.join(root, "scripts", "run.cjs"), "process.exit(0)\n");
    await run(root, outer);
  } finally { await rm(outer, { recursive: true, force: true }); }
}
function contractFor(artifactPaths: string[], definitionPaths: string[] = []) {
  return readTaskVerificationContract({ objective: "verify the declared candidate and unchanged checks", artifactPaths, checks: [{ id: "run", command: "node dist/run.cjs", definitionPaths }] });
}
async function verify(root: string, contract: TaskVerificationContract, executor: TaskCommandExecutor = { executeTaskCheck: async () => success }) {
  const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, []);
  const evidence = await verifyTaskCandidate({ workspaceRoot: root, ignore: [], taskRunId: "task", attemptId: "attempt", contract, definitionFingerprint, executor });
  return { evidence, definitionFingerprint };
}
async function linkRun(root: string) { await symlink("../scripts/run.cjs", path.join(root, "dist", "run.cjs")); }

test("real successful linked artifact cannot reuse evidence after its target starts failing", links, async () => {
  await fixture(async root => {
    await linkRun(root); const contract = contractFor(["dist"]);
    const { evidence, definitionFingerprint } = await verify(root, contract, { executeTaskCheck: async () => { await execute(process.execPath, [path.join(root, "dist", "run.cjs")]); return success; } });
    assert.equal(evidence.status, "passed");
    assert.equal(await canReuseTaskVerification({ workspaceRoot: root, ignore: [], contract, definitionFingerprint, evidence }), true);
    await writeFile(path.join(root, "scripts", "run.cjs"), "process.exit(7)\n");
    await assert.rejects(execute(process.execPath, [path.join(root, "dist", "run.cjs")]), { code: 7 });
    assert.equal(await canReuseTaskVerification({ workspaceRoot: root, ignore: [], contract, definitionFingerprint, evidence }), false);
  });
});

test("weakening a linked check definition is rejected before the new check can execute", links, async () => {
  await fixture(async root => {
    await linkRun(root); await writeFile(path.join(root, "scripts", "run.cjs"), "process.exit(7)\n");
    await assert.rejects(execute(process.execPath, [path.join(root, "dist", "run.cjs")]), { code: 7 });
    const contract = contractFor(["artifact.txt"], ["dist"]);
    const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, []);
    await writeFile(path.join(root, "scripts", "run.cjs"), "process.exit(0)\n");
    let calls = 0;
    const evidence = await verifyTaskCandidate({ workspaceRoot: root, ignore: [], taskRunId: "task", attemptId: "attempt", contract, definitionFingerprint, executor: { executeTaskCheck: async () => { calls++; await execute(process.execPath, [path.join(root, "dist", "run.cjs")]); return success; } } });
    assert.equal(evidence.status, "blocked"); assert.match(evidence.reason ?? "", /definition inputs changed/u); assert.equal(calls, 0);
  });
});

for (const kind of ["artifact", "definition"] as const) {
  test(`linked ${kind} target changes during a successful check invalidate evidence`, links, async () => {
    await fixture(async root => {
      await linkRun(root);
      const contract = kind === "artifact" ? contractFor(["dist"]) : contractFor(["artifact.txt"], ["dist"]);
      const { evidence } = await verify(root, contract, { executeTaskCheck: async () => { await writeFile(path.join(root, "scripts", "run.cjs"), "process.exit(7)\n"); return success; } });
      assert.equal(evidence.checks[0]?.status, "passed"); assert.equal(evidence.status, "blocked");
      assert.match(evidence.reason ?? "", kind === "artifact" ? /Candidate artifacts changed/u : /definition inputs changed/u);
    });
  });
}

test("direct link artifact retains existing canonical-target detection", links, async () => {
  await fixture(async root => {
    await linkRun(root); const before = await fingerprintTaskArtifacts(root, ["dist/run.cjs"], []);
    await writeFile(path.join(root, "scripts", "run.cjs"), "process.exit(7)\n");
    assert.notEqual(await fingerprintTaskArtifacts(root, ["dist/run.cjs"], []), before);
  });
});

test("directory aliases bind recursively nested target content", links, async () => {
  await fixture(async root => {
    await symlink("../scripts", path.join(root, "dist", "bundle"));
    const before = await fingerprintTaskArtifacts(root, ["dist"], []);
    await writeFile(path.join(root, "scripts", "run.cjs"), "process.exit(7)\n");
    assert.notEqual(await fingerprintTaskArtifacts(root, ["dist"], []), before);
  });
});

test("two aliases and a later direct visit do not falsely look like a cycle", links, async () => {
  await fixture(async root => {
    await symlink("../scripts", path.join(root, "dist", "a")); await symlink("../scripts", path.join(root, "dist", "b"));
    const before = await fingerprintTaskArtifacts(root, ["."], []);
    assert.equal(await fingerprintTaskArtifacts(root, ["."], []), before);
    await writeFile(path.join(root, "scripts", "run.cjs"), "changed");
    assert.notEqual(await fingerprintTaskArtifacts(root, ["."], []), before);
  });
});

test("multi-hop file aliases bind the final target and changing an intermediate link invalidates identity", links, async () => {
  await fixture(async root => {
    await symlink("run.cjs", path.join(root, "scripts", "alias")); await symlink("../scripts/alias", path.join(root, "dist", "run"));
    const before = await fingerprintTaskArtifacts(root, ["dist"], []);
    await writeFile(path.join(root, "scripts", "other.cjs"), "process.exit(0)\n");
    await unlink(path.join(root, "scripts", "alias")); await symlink("other.cjs", path.join(root, "scripts", "alias"));
    assert.notEqual(await fingerprintTaskArtifacts(root, ["dist"], []), before);
  });
});

test("retargeting a visible link remains distinguishable even with identical target bytes", links, async () => {
  await fixture(async root => {
    await linkRun(root); const before = await fingerprintTaskArtifacts(root, ["dist"], []);
    await writeFile(path.join(root, "scripts", "other.cjs"), await readFile(path.join(root, "scripts", "run.cjs")));
    await unlink(path.join(root, "dist", "run.cjs")); await symlink("../scripts/other.cjs", path.join(root, "dist", "run.cjs"));
    assert.notEqual(await fingerprintTaskArtifacts(root, ["dist"], []), before);
  });
});

for (const kind of ["dangling", "external", "ignored", "protected", "parent-cycle", "directory-cycle", "link-cycle", "fifo"] as const) {
  test(`recursive ${kind} link fails closed instead of proving only link text`, links, async () => {
    await fixture(async (root, outer) => {
      let target = "../missing";
      if (kind === "external") { await writeFile(path.join(outer, "outside.txt"), "outside"); target = "../../outside.txt"; }
      if (kind === "ignored") { await mkdir(path.join(root, "ignored")); await writeFile(path.join(root, "ignored", "x"), "ignored"); target = "../ignored/x"; }
      if (kind === "protected") { await writeFile(path.join(root, ".env"), "SYNTHETIC_VALUE=example"); target = "../.env"; }
      if (kind === "parent-cycle") target = "..";
      if (kind === "directory-cycle") { await symlink("../dist", path.join(root, "scripts", "back")); target = "../scripts"; }
      if (kind === "link-cycle") { await symlink("../dist/link", path.join(root, "scripts", "cycle")); target = "../scripts/cycle"; }
      if (kind === "fifo") { await execute("mkfifo", [path.join(root, "pipe")]); target = "../pipe"; }
      await symlink(target, path.join(root, "dist", "link"));
      await assert.rejects(fingerprintTaskArtifacts(root, ["dist"], ["ignored"]));
    });
  });
}

test("ignored link entries stay unvisited and unrelated writes do not invalidate declared files", links, async () => {
  await fixture(async (root, outer) => {
    await symlink(path.join(outer, "missing"), path.join(root, "dist", "ignored"));
    const before = await fingerprintTaskArtifacts(root, ["dist"], ["ignored"]);
    await writeFile(path.join(root, "scripts", "run.cjs"), "changed");
    assert.equal(await fingerprintTaskArtifacts(root, ["dist"], ["ignored"]), before);
  });
});

test("workspace-root aliases remain valid for internal linked targets", links, async () => {
  await fixture(async (root, outer) => {
    await linkRun(root); const alias = path.join(outer, "workspace-alias"); await symlink(root, alias);
    const before = await fingerprintTaskArtifacts(alias, ["dist"], []);
    assert.equal(await fingerprintTaskArtifacts(alias, ["dist"], []), before);
    await writeFile(path.join(root, "scripts", "run.cjs"), "changed");
    assert.notEqual(await fingerprintTaskArtifacts(alias, ["dist"], []), before);
  });
});

test("workspace snapshots still assign changes to the real path, not aliases", links, async () => {
  await fixture(async root => {
    await linkRun(root); const before = await captureTaskWorkspaceSnapshot(root, []);
    await writeFile(path.join(root, "scripts", "run.cjs"), "changed");
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, []), ["dist"]).violationPaths, ["scripts/run.cjs"]);
  });
});

test("unchanged ordinary files remain reusable without symlinks", async () => {
  await fixture(async root => {
    const contract = contractFor(["artifact.txt"]); const { evidence, definitionFingerprint } = await verify(root, contract);
    assert.equal(evidence.status, "passed"); assert.equal(await canReuseTaskVerification({ workspaceRoot: root, ignore: [], contract, definitionFingerprint, evidence }), true);
  });
});

test("pre-aborted fingerprinting and verification still cancel without dispatch", async () => {
  await fixture(async root => {
    await assert.rejects(fingerprintTaskArtifacts(root, ["dist"], [], AbortSignal.abort()));
    const contract = contractFor(["artifact.txt"]), definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, []);
    const result = await verifyTaskCandidate({ workspaceRoot: root, ignore: [], taskRunId: "task", attemptId: "attempt", contract, definitionFingerprint, signal: AbortSignal.abort(), executor: { executeTaskCheck: async () => assert.fail("must not dispatch") } });
    assert.equal(result.status, "cancelled");
  });
});


test("legacy recursive link-text-only evidence fails closed, while fresh linked evidence is reusable", links, async () => {
  await fixture(async root => {
    await linkRun(root); const contract = contractFor(["dist"]);
    const { evidence, definitionFingerprint } = await verify(root, contract);
    const legacy = createHash("sha256").update("directory\0dist\0symlink\0dist/run.cjs\0../scripts/run.cjs\0").digest("hex");
    assert.equal(await canReuseTaskVerification({ workspaceRoot: root, ignore: [], contract, definitionFingerprint, evidence: { ...evidence, artifactFingerprint: legacy } }), false);
    assert.equal(await canReuseTaskVerification({ workspaceRoot: root, ignore: [], contract, definitionFingerprint, evidence }), true);
  });
});

test("retargeting a declared check outside the workspace blocks before dispatch", links, async () => {
  await fixture(async (root, outer) => {
    await linkRun(root); const contract = contractFor(["artifact.txt"], ["dist"]);
    const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, []);
    await writeFile(path.join(outer, "external.cjs"), "process.exit(0)");
    await unlink(path.join(root, "dist", "run.cjs")); await symlink("../../external.cjs", path.join(root, "dist", "run.cjs"));
    let calls = 0;
    const evidence = await verifyTaskCandidate({ workspaceRoot: root, ignore: [], taskRunId: "task", attemptId: "attempt", contract, definitionFingerprint, executor: { executeTaskCheck: async () => { calls++; return success; } } });
    assert.equal(evidence.status, "blocked"); assert.equal(calls, 0);
  });
});


for (const kind of ["external", "dangling", "cycle"] as const) {
  test(`invalid ${kind} artifact link blocks verification without dispatch`, links, async () => {
    await fixture(async (root, outer) => {
      if (kind === "external") await writeFile(path.join(outer, "outside.txt"), "outside");
      const target = kind === "external" ? "../../outside.txt" : kind === "cycle" ? ".." : "../missing";
      await symlink(target, path.join(root, "dist", "link"));
      let calls = 0;
      const { evidence } = await verify(root, contractFor(["dist"]), { executeTaskCheck: async () => { calls++; return success; } });
      assert.equal(evidence.status, "blocked"); assert.match(evidence.reason ?? "", /Cannot fingerprint candidate artifacts/u); assert.equal(calls, 0);
    });
  });
}
