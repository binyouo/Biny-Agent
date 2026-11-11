from types import SimpleNamespace
import signal
import unittest
from unittest.mock import patch

from harbor.cli.job_plugins import attach_job_plugin


class StopOnErrorTests(unittest.IsolatedAsyncioTestCase):
    async def test_oracle_preflight_stops_unless_the_verifier_passes(self):
        callbacks = []
        await attach_job_plugin(
            SimpleNamespace(on_trial_ended=callbacks.append),
            "scripts.evals.harbor.stop_on_error:StopOnError",
            kwargs={"require_reward": True},
        )
        for reward in [None, 0.0, 1.0]:
            with self.subTest(reward=reward), patch(
                "scripts.evals.harbor.stop_on_error.signal.raise_signal"
            ) as stop:
                await callbacks[0](SimpleNamespace(
                    trial_name="oracle-preflight",
                    result=SimpleNamespace(
                        exception_info=None,
                        verifier_result=SimpleNamespace(rewards={"reward": reward}),
                    ),
                ))
                if reward == 1.0:
                    stop.assert_not_called()
                else:
                    stop.assert_called_once_with(signal.SIGINT)

    async def test_native_plugin_stops_on_exception_and_keeps_valid_zero_scores(self):
        callbacks = []
        job = SimpleNamespace(on_trial_ended=callbacks.append)
        await attach_job_plugin(job, "scripts.evals.harbor.stop_on_error:StopOnError")
        self.assertEqual(len(callbacks), 1)
        for reward, exception, should_stop in [
            (0.0, None, False),
            (1.0, None, False),
            (None, SimpleNamespace(exception_type="UnknownApiError"), True),
            (None, SimpleNamespace(exception_type="RuntimeError"), True),
        ]:
            with self.subTest(reward=reward, exception=exception), patch(
                "scripts.evals.harbor.stop_on_error.signal.raise_signal"
            ) as stop:
                await callbacks[0](SimpleNamespace(
                    trial_name="test-trial",
                    result=SimpleNamespace(exception_info=exception, verifier_result={"reward": reward}),
                ))
                if should_stop:
                    stop.assert_called_once_with(signal.SIGINT)
                else:
                    stop.assert_not_called()


if __name__ == "__main__":
    unittest.main()
