"""Stop a serial model evaluation after an infrastructure or provider exception."""

import logging
import signal

from harbor.models.job.plugin import BaseJobPlugin


class StopOnError(BaseJobPlugin):
    def __init__(self, require_reward: bool = False) -> None:
        self.require_reward = require_reward

    async def on_job_start(self, job) -> None:
        async def ended(event):
            exception = event.result.exception_info
            verifier = event.result.verifier_result
            missing_pass = self.require_reward and (
                verifier is None or (verifier.rewards or {}).get("reward") != 1.0
            )
            if exception is not None or missing_pass:
                logging.getLogger(__name__).error(
                    "Stopping evaluation after %s: %s",
                    event.trial_name,
                    exception.exception_type if exception is not None else "preflight verifier did not pass",
                )
                signal.raise_signal(signal.SIGINT)

        job.on_trial_ended(ended)

    async def on_job_end(self, job_result) -> None:
        pass
