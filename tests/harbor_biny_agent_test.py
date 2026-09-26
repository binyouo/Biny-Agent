"""Regression tests for the Harbor adapter's effective model and runtime limits."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from harbor.models.agent.context import AgentContext
from scripts.evals.harbor.biny_agent import (
    BinyAgent,
    ensure_package,
    make_config,
    write_evaluation_provenance,
)
from scripts.evals.harbor.fast_verifier import _patch_test_script


class EvaluationConfigurationTests(unittest.TestCase):
    def test_deepseek_v41_uses_full_preset_context_by_default(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = make_config("deepseek-v4.1-flash")

        self.assertEqual(
            config["models"]["deepseek-v4.1-flash"]["contextWindow"], 1_000_000
        )
        self.assertEqual(config["agent"]["maxToolCalls"], 65_536)

    def test_context_window_environment_override_takes_precedence(self) -> None:
        config = make_config(
            "deepseek-v4.1-flash",
            {"BINY_EVAL_CONTEXT_WINDOW": "262144"},
        )

        self.assertEqual(
            config["models"]["deepseek-v4.1-flash"]["contextWindow"], 262_144
        )

    def test_invalid_context_override_fails_instead_of_silently_falling_back(self) -> None:
        with self.assertRaises(ValueError):
            make_config("deepseek-v4.1-flash", {"BINY_EVAL_CONTEXT_WINDOW": "0"})

    def test_effective_configuration_is_written_for_each_trial(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = make_config("deepseek-v4.1-flash")
            config["providers"]["commandcode"]["baseUrl"] = (
                "https://user:pass@example.com/provider/v1?token=private-token"
            )
            with tempfile.TemporaryDirectory() as directory:
                path = write_evaluation_provenance(
                    Path(directory), "deepseek-v4.1-flash", config, None
                )
                saved_text = path.read_text(encoding="utf-8")
                saved = json.loads(saved_text)

        self.assertEqual(saved["modelAlias"], "deepseek-v4.1-flash")
        self.assertEqual(saved["contextWindow"], 1_000_000)
        self.assertIsNone(saved["agentExecTimeoutSec"])
        self.assertEqual(saved["agentExecTimeoutSource"], "harbor-trial-deadline")
        self.assertEqual(
            saved["binyConfig"]["providers"]["commandcode"]["baseUrl"],
            "https://example.com/provider/v1",
        )
        self.assertNotIn("user:pass", saved_text)
        self.assertNotIn("private-token", saved_text)


class HarborPackageTests(unittest.TestCase):
    def test_package_build_failure_preserves_pnpm_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src").mkdir()
            (root / "src" / "entry.ts").write_text("export {};\n", encoding="utf-8")
            (root / "package.json").write_text("{}\n", encoding="utf-8")
            cache = root / ".agent" / "harbor"
            cache.mkdir(parents=True)
            stale_package = cache / "biny012-biny-stale.tgz"
            stale_package.write_bytes(b"stale")
            os.utime(stale_package, (1, 1))
            failure = subprocess.CalledProcessError(
                2,
                ["pnpm", "pack"],
                output="ERR_PNPM_PACK_FAILED: fixture diagnostic",
            )

            with (
                patch("scripts.evals.harbor.biny_agent.REPO_ROOT", root),
                patch("scripts.evals.harbor.biny_agent.PACKAGE_CACHE", cache),
                patch(
                    "scripts.evals.harbor.biny_agent.PACKAGE_FILE_LOCK",
                    cache / ".lock",
                ),
                patch("scripts.evals.harbor.biny_agent.subprocess.run", side_effect=failure),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "ERR_PNPM_PACK_FAILED: fixture diagnostic"
                ):
                    ensure_package()


class HarborRunSettingsTests(unittest.TestCase):
    def test_run_script_uses_pass_at_one_attempt_and_timeout_defaults(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            bin_dir = temp_path / "bin"
            bin_dir.mkdir()
            harbor = bin_dir / "harbor"
            harbor.write_text(
                '#!/bin/sh\nprintf "%s\\n" "$@" > "$BINY_EVAL_CAPTURE_ARGS"\n',
                encoding="utf-8",
            )
            harbor.chmod(0o755)
            docker = bin_dir / "docker"
            docker.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            docker.chmod(0o755)

            capture_path = temp_path / "args.txt"
            env = os.environ.copy()
            env.pop("BINY_EVAL_ATTEMPTS", None)
            env.pop("BINY_EVAL_AGENT_TIMEOUT_MULTIPLIER", None)
            env.pop("BINY_EVAL_KEY_FILE", None)
            env["PATH"] = f"{bin_dir}:{env['PATH']}"
            env["BINY_EVAL_CAPTURE_ARGS"] = str(capture_path)
            env["BINY_EVAL_JOBS_DIR"] = str(temp_path / "jobs")

            result = subprocess.run(
                ["bash", "scripts/evals/harbor/run-tb21.sh", "--job-name", "settings-test"],
                cwd=repo_root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            args = capture_path.read_text(encoding="utf-8").splitlines()

        self.assertEqual(args[args.index("--n-attempts") + 1], "1")
        self.assertEqual(args[args.index("--agent-timeout-multiplier") + 1], "1")
        self.assertEqual(args[args.index("--max-retries") + 1], "0")
        self.assertEqual(
            args[args.index("--verifier") + 1],
            "scripts.evals.harbor.fast_verifier:FastVerifier",
        )


class FastVerifierTests(unittest.TestCase):
    def test_mteb_verifier_keeps_uv_fallback_when_preloaded_python_is_absent(self) -> None:
        script = """#!/bin/bash
apt-get update
apt-get install -y curl
curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh
source $HOME/.local/bin/env
uvx \\
  -p 3.13 \\
  -w pytest==8.4.1 \\
  -w pytest-json-ctrf==0.3.5 \\
  pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.sh"
            path.write_text(script, encoding="utf-8")

            _patch_test_script(path)

            patched = path.read_text(encoding="utf-8")
            syntax = subprocess.run(
                ["bash", "-n", str(path)], capture_output=True, text=True, check=False
            )

        self.assertIn("/usr/local/bin/biny-verifier-pytest", patched)
        self.assertIn('if [ -x "/usr/local/bin/biny-verifier-pytest" ]; then', patched)
        self.assertIn("else\n  UV_OFFLINE=false uvx", patched)
        self.assertIn("export UV_PYTHON_DOWNLOADS=automatic", patched)
        self.assertIn("curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh", patched)
        self.assertIn("apt-get install -y curl", patched)
        self.assertIn("source $HOME/.local/bin/env", patched)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

    def test_missing_preload_executes_original_arm64_bootstrap_and_downloads_python(self) -> None:
        script = """#!/bin/bash
apt-get update
apt-get install -y curl
curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh
source $HOME/.local/bin/env
uvx \\
  -p 3.13 \\
  -w pytest==8.4.1 \\
  -w pytest-json-ctrf==0.3.5 \\
  pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA
if [ $? -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            call_log = root / "calls.txt"
            home = root / "home"
            (home / ".local" / "bin").mkdir(parents=True)
            (home / ".local" / "bin" / "env").write_text("", encoding="utf-8")
            log_dir = root / "logs" / "verifier"
            log_dir.mkdir(parents=True)
            path = root / "test.sh"
            path.write_text(script, encoding="utf-8")
            _patch_test_script(path)
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "/logs/verifier", str(log_dir)
                ),
                encoding="utf-8",
            )

            (bin_dir / "apt-get").write_text(
                '#!/bin/sh\nprintf "apt-get %s\\n" "$*" >> "$BINY_TEST_CALLS"\n',
                encoding="utf-8",
            )
            (bin_dir / "curl").write_text(
                '#!/bin/sh\nprintf "curl %s\\n" "$*" >> "$BINY_TEST_CALLS"\nprintf ":\\n"\n',
                encoding="utf-8",
            )
            (bin_dir / "uvx").write_text(
                '#!/bin/sh\nprintf "uvx python=%s args=%s\\n" "$UV_PYTHON_DOWNLOADS" "$*" >> "$BINY_TEST_CALLS"\nexit 0\n',
                encoding="utf-8",
            )
            for command in bin_dir.iterdir():
                command.chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "HOME": str(home),
                    "PATH": f"{bin_dir}:/usr/bin:/bin",
                    "BINY_TEST_CALLS": str(call_log),
                    "UV_PYTHON_DOWNLOADS": "never",
                }
            )
            result = subprocess.run(
                ["bash", str(path)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((log_dir / "reward.txt").read_text(), "1\n")
            calls = call_log.read_text(encoding="utf-8")

        self.assertIn("apt-get update", calls)
        self.assertIn("apt-get install -y curl", calls)
        self.assertIn("curl -LsSf https://astral.sh/uv/0.9.5/install.sh", calls)
        self.assertIn("uvx python=automatic", calls)

    def test_preloaded_verifier_skips_network_bootstrap_at_runtime(self) -> None:
        script = """#!/bin/bash
apt-get update
apt-get install -y curl
curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh
source $HOME/.local/bin/env
uvx \\
  -p 3.13 \\
  -w pytest==8.4.1 \\
  -w pytest-json-ctrf==0.3.5 \\
  pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            call_log = root / "calls.txt"
            preloaded = bin_dir / "biny-verifier-pytest"
            preloaded.write_text(
                '#!/bin/sh\nprintf "pytest %s\\n" "$*" >> "$BINY_TEST_CALLS"\nexit 0\n',
                encoding="utf-8",
            )
            preloaded.chmod(0o755)
            path = root / "test.sh"
            path.write_text(script, encoding="utf-8")
            with patch(
                "scripts.evals.harbor.fast_verifier._PYTEST_BIN", str(preloaded)
            ):
                _patch_test_script(path)

            (bin_dir / "apt-get").write_text(
                '#!/bin/sh\nprintf "apt-get %s\\n" "$*" >> "$BINY_TEST_CALLS"\n',
                encoding="utf-8",
            )
            (bin_dir / "curl").write_text(
                '#!/bin/sh\nprintf "curl %s\\n" "$*" >> "$BINY_TEST_CALLS"\nprintf ":\\n"\n',
                encoding="utf-8",
            )
            (bin_dir / "uvx").write_text(
                '#!/bin/sh\nprintf "uvx %s\\n" "$*" >> "$BINY_TEST_CALLS"\n',
                encoding="utf-8",
            )
            for command in bin_dir.iterdir():
                command.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{bin_dir}:/usr/bin:/bin",
                    "BINY_TEST_CALLS": str(call_log),
                }
            )
            result = subprocess.run(
                ["bash", str(path)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            calls = call_log.read_text(encoding="utf-8")

        self.assertIn("pytest --ctrf", calls)
        self.assertNotIn("apt-get", calls)
        self.assertNotIn("curl", calls)
        self.assertNotIn("uvx", calls)

    def test_qemu_verifier_uses_sshpass_fast_path_and_keeps_arm_fallback(self) -> None:
        script = """#!/bin/bash
apt-get update
apt-get install -y curl sshpass
curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh
source $HOME/.local/bin/env
uvx \\
  -p 3.13 \\
  -w pytest==8.4.1 \\
  -w pytest-json-ctrf==0.3.5 \\
  pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.sh"
            path.write_text(script, encoding="utf-8")

            _patch_test_script(path)

            patched = path.read_text(encoding="utf-8")
            syntax = subprocess.run(
                ["bash", "-n", str(path)], capture_output=True, text=True, check=False
            )

        self.assertIn("apt-get install -y sshpass", patched)
        self.assertIn("apt-get install -y curl sshpass", patched)
        self.assertIn("apt-get update", patched)
        self.assertIn("/usr/local/bin/biny-verifier-pytest", patched)
        self.assertIn('if [ -x "/usr/local/bin/biny-verifier-pytest" ]; then', patched)
        self.assertIn("source $HOME/.local/bin/env", patched)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)


class HarborClassificationTests(unittest.TestCase):
    def test_verifier_environment_failures_are_not_model_assertion_failures(self) -> None:
        cases = {
            "mteb-leaderboard": (
                "error: No interpreter found for Python 3.13 in managed installations "
                "or search path\n"
                "hint: Python downloads are set to 'never'\n"
            ),
            "qemu-alpine-ssh": (
                "E: Failed to fetch curl_amd64.deb 404 Not Found\n"
                "FileNotFoundError: [Errno 2] No such file or directory: 'sshpass'\n"
                "=========================== 1 failed in 0.26s ===========================\n"
            ),
            "install-windows-3.11": (
                "========================= 3 passed, 1 failed in 1.2s =========================\n"
            ),
            "compile-compcert": "",
            "cobol-modernization": "========================= 2 passed in 1.2s =========================\n",
            "regex-chess": "========================= 1 passed in 1.2s =========================\n",
        }
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            trials = []
            for task, verifier_output in cases.items():
                trial_name = f"{task}__test"
                trials.append(trial_name)
                verifier_dir = job / trial_name / "verifier"
                verifier_dir.mkdir(parents=True)
                (verifier_dir / "test-stdout.txt").write_text(
                    verifier_output, encoding="utf-8"
                )
                reward = "1" if task in {"cobol-modernization", "regex-chess"} else "0"
                (verifier_dir / "reward.txt").write_text(
                    f"{reward}\n", encoding="utf-8"
                )

            (job / "result.json").write_text(
                json.dumps(
                    {
                        "n_total_trials": len(trials),
                        "finished_at": "2026-09-25T00:00:00Z",
                        "stats": {
                            "n_running_trials": 0,
                            "n_pending_trials": 0,
                            "reward_stats": {
                                "reward": {
                                    "1.0": [
                                        trial
                                        for trial in trials
                                        if trial.startswith(
                                            ("cobol-modernization", "regex-chess")
                                        )
                                    ],
                                    "0.0": [
                                        trial
                                        for trial in trials
                                        if not trial.startswith(
                                            ("cobol-modernization", "regex-chess")
                                        )
                                    ],
                                }
                            },
                            "exception_stats": {
                                "AgentTimeoutError": [
                                    "compile-compcert__test",
                                    "regex-chess__test",
                                ]
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            repo_root = Path(__file__).resolve().parents[1]
            result = subprocess.run(
                [
                    sys.executable,
                    str(repo_root / "scripts/evals/harbor/classify_job.py"),
                    str(job),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            statuses = json.loads((job / "_status.json").read_text(encoding="utf-8"))

        rows_by_task = {row["task"].split("__")[0]: row for row in statuses}
        by_task = {task: row["status"] for task, row in rows_by_task.items()}
        self.assertEqual(by_task["mteb-leaderboard"], "infra_failed")
        self.assertEqual(by_task["qemu-alpine-ssh"], "infra_failed")
        self.assertEqual(by_task["install-windows-3.11"], "subject_failed")
        self.assertEqual(by_task["compile-compcert"], "timeout")
        self.assertEqual(rows_by_task["compile-compcert"]["reward"], 0.0)
        self.assertEqual(rows_by_task["compile-compcert"]["score"], "fail")
        self.assertEqual(by_task["cobol-modernization"], "completed")
        self.assertEqual(by_task["regex-chess"], "timeout")
        self.assertEqual(rows_by_task["regex-chess"]["reward"], 1.0)
        self.assertEqual(rows_by_task["regex-chess"]["score"], "pass")
        self.assertIn("官方 verifier Pass@1: 2/4 = 50.0%", result.stdout)


class AgentExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_delegates_default_command_timeout_to_harbor(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {}, clear=True
        ):
            agent = BinyAgent(Path(directory), model_name="deepseek-v4.1-flash")
            environment = FakeEnvironment()
            context = AgentContext()

            await agent.run("complete the task", environment, context)

            command_call = environment.calls[1]
            self.assertIsNone(command_call["timeout_sec"])
            self.assertIsNone(context.metadata["agent_exec_timeout_sec"])
            saved = json.loads(
                (Path(directory) / "biny-result.json").read_text(encoding="utf-8")
            )
            self.assertIsNone(saved["agent_exec_timeout_sec"])

    async def test_run_uses_json_mode_for_verifier_scored_incomplete_outcomes(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {}, clear=True
        ):
            agent = BinyAgent(Path(directory), model_name="deepseek-v4.1-flash")
            environment = FakeEnvironment()
            context = AgentContext()

            await agent.run("complete the task", environment, context)

            command = str(environment.calls[1]["command"])
            self.assertIn("biny run --json --", command)

    async def test_run_honors_explicit_command_timeout_override(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {}, clear=True
        ):
            agent = BinyAgent(
                Path(directory),
                model_name="deepseek-v4.1-flash",
                extra_env={"BINY_AGENT_EXEC_TIMEOUT_SEC": "1800"},
            )
            environment = FakeEnvironment()
            context = AgentContext()

            await agent.run("complete the task", environment, context)

            self.assertEqual(environment.calls[1]["timeout_sec"], 1800)
            self.assertEqual(context.metadata["agent_exec_timeout_sec"], 1800)


class FakeEnvironment:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> SimpleNamespace:
        self.calls.append(
            {
                "command": command,
                "cwd": cwd,
                "env": env,
                "timeout_sec": timeout_sec,
                "user": user,
            }
        )
        return SimpleNamespace(return_code=0, stdout="/workspace\n", stderr="")


if __name__ == "__main__":
    unittest.main()
