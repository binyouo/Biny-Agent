from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
CLASSIFIER = REPO_ROOT / "scripts" / "evals" / "harbor" / "classify_job.py"


class ClassifyJobTest(unittest.TestCase):
    def test_timeout_keeps_verifier_reward_in_pass_at_1(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            passed_trial = "timeout-pass__abc123"
            failed_trial = "timeout-fail__def456"
            unscored_trial = "timeout-unscored__ghi789"

            for trial, reward in (
                (passed_trial, 1.0),
                (failed_trial, 0.0),
                (unscored_trial, None),
            ):
                verifier = job / trial / "verifier"
                verifier.mkdir(parents=True)
                if reward is not None:
                    (verifier / "reward.txt").write_text(f"{reward}\n", encoding="utf-8")
                    (verifier / "test-stdout.txt").write_text(
                        "1 passed, 0 failed\n", encoding="utf-8"
                    )

            result = {
                "n_total_trials": 3,
                "finished_at": "2026-09-26T01:00:00Z",
                "stats": {
                    "n_running_trials": 0,
                    "n_pending_trials": 0,
                    "evals": {
                        "biny__deepseek-v4.1-flash__tasks": {
                            "exception_stats": {
                                "AgentTimeoutError": [
                                    passed_trial,
                                    failed_trial,
                                    unscored_trial,
                                ]
                            },
                            "reward_stats": {
                                "reward": {
                                    "1.0": [passed_trial],
                                    "0.0": [failed_trial],
                                }
                            },
                        }
                    },
                },
            }
            (job / "result.json").write_text(
                json.dumps(result), encoding="utf-8"
            )

            completed = subprocess.run(
                [sys.executable, str(CLASSIFIER), str(job)],
                check=True,
                capture_output=True,
                text=True,
            )

            rows = {
                row["task"]: row
                for row in json.loads((job / "_status.json").read_text(encoding="utf-8"))
            }
            self.assertEqual(rows["timeout-pass"]["status"], "timeout")
            self.assertEqual(rows["timeout-pass"]["reward"], 1.0)
            self.assertEqual(rows["timeout-pass"]["score"], "pass")
            self.assertEqual(rows["timeout-fail"]["status"], "timeout")
            self.assertEqual(rows["timeout-fail"]["reward"], 0.0)
            self.assertEqual(rows["timeout-fail"]["score"], "fail")
            self.assertEqual(rows["timeout-unscored"]["status"], "timeout")
            self.assertIsNone(rows["timeout-unscored"]["reward"])
            self.assertEqual(rows["timeout-unscored"]["score"], "unscored")
            self.assertIn("官方 verifier Pass@1: 1/2 = 50.0%", completed.stdout)


if __name__ == "__main__":
    unittest.main()
