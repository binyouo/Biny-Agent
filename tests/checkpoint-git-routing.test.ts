import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointStore } from "../src/session/checkpointStore.js";
const run = promisify(execFile);
for (const mode of ["clean", "dir", "worktree", "dir-worktree", "common", "index", "nonrepo", "linked", "split", "restore-routing"])
    test(`workspace checkpoint isolates Git routing: ${mode}`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-routing-")), prior = {
            ...process.env
        };
        const clean: NodeJS.ProcessEnv = {
            ...prior
        };
        for (const key of Object.keys(clean))
            if (key.startsWith("GIT_"))
                delete clean[key];
        Object.assign(clean, {
            HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "xdg"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty.gitconfig"), GIT_CONFIG_SYSTEM: path.join(root, "empty.gitconfig"), GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", BINY_AGENT_DIR: path.join(root, "state")
        });
        const git = async (cwd: string, args: string[]) => (await run("git", args, {
            cwd, env: clean
        })).stdout.trim();
        async function init(dir: string, marker: string) {
            await mkdir(dir, {
                recursive: true
            });
            await git(dir, ["init", "-q", "--template="]);
            await git(dir, ["config", "core.hooksPath", path.join(root, "no-hooks")]);
            await git(dir, ["config", "commit.gpgsign", "false"]);
            await writeFile(path.join(dir, "marker.txt"), marker);
            await git(dir, ["add", "marker.txt"]);
            await git(dir, ["commit", "-qm", "fixture"]);
        }
        async function state(dir: string) {
            const index = await git(dir, ["rev-parse", "--git-path", "index"]);
            return {
                head: await git(dir, ["rev-parse", "HEAD"]), index: await readFile(path.resolve(dir, index)), user: await readFile(path.join(dir, "marker.txt"))
            };
        }
        try {
            await mkdir(clean.HOME!, {
                recursive: true
            });
            await mkdir(clean.XDG_CONFIG_HOME!, {
                recursive: true
            });
            await writeFile(clean.GIT_CONFIG_GLOBAL!, "");
            for (const key of Object.keys(process.env))
                delete process.env[key];
            Object.assign(process.env, clean);
            const originalA = path.join(root, "A"), b = path.join(root, "B");
            await init(originalA, "A-before\n");
            await init(b, "B-untouched\n");
            let a = originalA;
            if (mode === "linked") {
                a = path.join(root, "linked");
                await git(originalA, ["worktree", "add", "-qb", "linked-fixture", a]);
            }
            if (mode === "split")
                await git(a, ["update-index", "--split-index"]);
            const aBefore = await state(a), bBefore = await state(b);
            const contaminate = () => {
                if (["dir", "dir-worktree", "nonrepo", "restore-routing"].includes(mode))
                    process.env.GIT_DIR = path.join(b, ".git");
                if (["worktree", "dir-worktree", "restore-routing"].includes(mode))
                    process.env.GIT_WORK_TREE = b;
                if (mode === "common")
                    process.env.GIT_COMMON_DIR = path.join(b, ".git");
                if (mode === "index")
                    process.env.GIT_INDEX_FILE = path.join(b, ".git", "index");
            };
            if (mode !== "restore-routing")
                contaminate();
            const expectedEnv = {
                ...process.env
            };
            if (mode === "nonrepo") {
                const notRepo = path.join(root, "not-repository");
                await mkdir(notRepo);
                assert.equal(await CheckpointStore.open(notRepo), undefined);
                assert.deepEqual({
                    ...process.env
                }, expectedEnv);
                assert.deepEqual(await state(a), aBefore);
                assert.deepEqual(await state(b), bBefore);
                return;
            }
            const store = await CheckpointStore.open(a);
            assert(store);
            const checkpoint = await store.create("routing fixture");
            assert.deepEqual({
                ...process.env
            }, expectedEnv);
            assert.deepEqual(await store.list(), [checkpoint]);
            assert.equal(await git(a, ["cat-file", "-t", checkpoint.commit]), "commit");
            assert.equal(await git(a, ["show", `${checkpoint.commit}:marker.txt`]), "A-before");
            assert.equal(await git(a, ["rev-parse", `refs/biny/checkpoints/${checkpoint.id}`]), checkpoint.commit);
            assert.deepEqual(await state(a), aBefore);
            assert.deepEqual(await state(b), bBefore);
            if (mode === "restore-routing")
                contaminate();
            const restoreEnv = {
                ...process.env
            };
            await writeFile(path.join(a, "marker.txt"), "A-changed-after-snapshot\n");
            await store.restore(checkpoint.id);
            assert.deepEqual({
                ...process.env
            }, restoreEnv);
            assert.deepEqual(await state(a), aBefore);
            assert.deepEqual(await state(b), bBefore);
        }
        finally {
            for (const key of Object.keys(process.env))
                delete process.env[key];
            Object.assign(process.env, prior);
            await rm(root, {
                recursive: true, force: true
            });
        }
    });
