"""Harbor/Pier external-agent adapter for Biny.

The benchmark harness owns the task container and verifier.  This adapter only
starts Biny in the task workdir, passes through explicitly configured runtime
environment variables, and maps Biny's structured ``biny run --json`` result to
Harbor's ``AgentContext``.  A non-completed Biny terminal state is preserved as
an agent result so the benchmark verifier can score the workspace; only a
missing structured result is treated as an adapter/infrastructure error.
"""

from __future__ import annotations

import json
import shlex
from numbers import Real
from typing import Any

from .harness_compat import AgentContext, BaseAgent, BaseEnvironment


class BinyAgent(BaseAgent):
    """Run the Biny CLI as a Harbor/Pier external agent."""

    SUPPORTS_ATIF = False
    SUPPORTS_RESUME = False
    SUPPORTS_CONFIG = False
    SUPPORTS_WINDOWS = False

    @staticmethod
    def name() -> str:
        return "biny"

    def version(self) -> str | None:
        return self._env("BINY_AGENT_VERSION") or "external-cli"

    async def setup(self, environment: BaseEnvironment) -> None:
        self._validate_model_binding()
        result = await environment.exec(
            f"{self._command_string()} --version",
            env=self._agent_env(),
            timeout_sec=30,
        )
        if result.return_code != 0:
            detail = _tail(result.stderr or result.stdout)
            raise RuntimeError(
                f"Biny command is unavailable or failed its version check: "
                f"{self._command_display()}" + (f" ({detail})" if detail else "")
            )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._validate_model_binding()
        command = self._run_command(instruction)
        # Harbor 在外层 deadline 到达时会取消整个 run；先记录启动事实，避免超时样例只剩
        # 一个空 AgentContext。若 BINY_AGENT_DIR 位于 /logs/agent 下，对应 session 也会随
        # Harbor agent logs 一起持久化，便于区分慢模型、循环执行和工具阻塞。
        existing_metadata = dict(context.metadata or {})
        existing_metadata["biny"] = {
            "status": "running",
            "modelAlias": self._env("BINY_MODEL_ALIAS"),
            "stateDir": self._env("BINY_AGENT_DIR"),
        }
        context.metadata = existing_metadata
        result = await environment.exec(
            command,
            env=self._agent_env(),
            timeout_sec=self._timeout_seconds(),
        )
        payload = _last_json_object(result.stdout)
        if payload is None:
            detail = _tail(result.stderr or result.stdout)
            raise RuntimeError(
                "Biny did not emit a structured JSON result. "
                "Check BINY_COMMAND, BINY_AGENT_DIR, and the in-container Biny config."
                + (f" Output: {detail}" if detail else "")
            )

        artifacts = await self._persist_artifacts(environment, payload)
        usage = _record_usage(context, payload.get("usage"))
        existing_metadata = dict(context.metadata or {})
        existing_metadata["biny"] = {
            "status": payload.get("status"),
            "stopReason": payload.get("stopReason"),
            "steps": payload.get("steps"),
            "error": payload.get("error"),
            "sessionId": payload.get("sessionId"),
            "sessionFile": payload.get("sessionFile"),
            "modelAlias": payload.get("modelAlias"),
            "provider": payload.get("provider"),
            "model": payload.get("model"),
            "usage": usage,
            "returnCode": result.return_code,
            "artifacts": artifacts,
        }
        context.metadata = existing_metadata

    async def _persist_artifacts(
        self,
        environment: BaseEnvironment,
        payload: dict[str, Any],
    ) -> dict[str, str]:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        result_path = self.logs_dir / "biny-result.json"
        result_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        artifacts = {"resultFile": str(result_path)}
        session_file = payload.get("sessionFile")
        if not isinstance(session_file, str) or not session_file.strip():
            return artifacts
        session_path = self.logs_dir / "biny-session.jsonl"
        try:
            await environment.download_file(session_file, session_path)
        except Exception as error:  # noqa: BLE001 - artifact copy must not change task score.
            self.logger.warning("Could not download Biny session %s: %s", session_file, error)
            return artifacts
        artifacts["sessionFile"] = str(session_path)
        return artifacts

    def _env(self, name: str) -> str | None:
        configured = getattr(self, "extra_env", {}) or {}
        value = configured.get(name)
        return value.strip() if isinstance(value, str) and value.strip() else None

    def _agent_env(self) -> dict[str, str]:
        configured = getattr(self, "extra_env", {}) or {}
        return {str(key): str(value) for key, value in configured.items()}

    def _command_argv(self) -> list[str]:
        raw = self._env("BINY_COMMAND") or "biny"
        try:
            command = shlex.split(raw)
        except ValueError as error:
            raise RuntimeError(f"Invalid BINY_COMMAND: {error}") from error
        if not command:
            raise RuntimeError("BINY_COMMAND must not be empty.")
        return command

    def _command_display(self) -> str:
        return shlex.join(self._command_argv())

    def _command_string(self) -> str:
        return self._command_display()

    def _run_command(self, instruction: str) -> str:
        args = [*self._command_argv(), "run", "--json", "--headless"]
        model_alias = self._env("BINY_MODEL_ALIAS")
        if model_alias:
            args.extend(["--model", model_alias])
        max_steps = self._positive_env_int("BINY_MAX_STEPS")
        if max_steps is not None:
            args.extend(["--max-steps", str(max_steps)])
        soft_steps = self._positive_env_int("BINY_SOFT_STEPS")
        if soft_steps is not None:
            args.extend(["--soft-steps", str(soft_steps)])
        permission_mode = self._env("BINY_PERMISSION_MODE") or "full-access"
        if permission_mode not in {"ask", "read-only", "auto", "full-access"}:
            raise RuntimeError(
                "BINY_PERMISSION_MODE must be one of ask, read-only, auto, full-access."
            )
        args.extend(["--permission-mode", permission_mode, "--", instruction])
        command = shlex.join(args)
        log_dir = self._env("BINY_RUN_LOG_DIR")
        if log_dir is None:
            return command
        if not log_dir.startswith("/"):
            raise RuntimeError("BINY_RUN_LOG_DIR must be an absolute path.")
        stdout_path = shlex.quote(f"{log_dir.rstrip('/')}/biny.stdout")
        stderr_path = shlex.quote(f"{log_dir.rstrip('/')}/biny.stderr")
        # environment.exec 会缓存子进程输出；Harbor 外层超时取消 exec 时，缓存内容无法返回。
        # 先写到持久日志目录，正常结束后再回放，既保留原有 JSON 解析，也让超时样例留下诊断。
        return (
            f"mkdir -p {shlex.quote(log_dir)} && "
            f"{command} > {stdout_path} 2> {stderr_path}; "
            "biny_status=$?; "
            f"cat {stdout_path}; cat {stderr_path} >&2; "
            "exit $biny_status"
        )

    def _positive_env_int(self, name: str) -> int | None:
        value = self._env(name)
        if value is None:
            return None
        try:
            parsed = int(value)
        except ValueError as error:
            raise RuntimeError(f"{name} must be a positive integer.") from error
        if parsed < 1 or parsed > 1024:
            raise RuntimeError(f"{name} must be between 1 and 1024.")
        return parsed

    def _timeout_seconds(self) -> int:
        # 外层 Harbor exec 的 deadline 要和 Biny/任务的长命令 deadline 分开配置。
        # 优先使用专门的 adapter deadline，避免把默认的短运行时配置误当成
        # 整个 trial 的命令执行上限。
        value = self._env("BINY_AGENT_EXEC_TIMEOUT_SEC") or self._env("BINY_TIMEOUT_SEC")
        if value is None:
            return 5_400
        try:
            timeout = int(value)
        except ValueError as error:
            raise RuntimeError(
                "BINY_AGENT_EXEC_TIMEOUT_SEC/BINY_TIMEOUT_SEC must be a positive integer."
            ) from error
        if timeout < 1:
            raise RuntimeError(
                "BINY_AGENT_EXEC_TIMEOUT_SEC/BINY_TIMEOUT_SEC must be a positive integer."
            )
        return timeout

    def _validate_model_binding(self) -> None:
        if self.model_name and not self._env("BINY_MODEL_ALIAS"):
            raise RuntimeError(
                "Harbor supplied a model but Biny's configured alias is unknown. "
                "Set BINY_MODEL_ALIAS to the matching alias in Biny config.json."
            )


def _last_json_object(stdout: str | None) -> dict[str, Any] | None:
    for line in reversed((stdout or "").splitlines()):
        candidate = line.strip()
        if not candidate.startswith("{"):
            continue
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(value, dict)
            and isinstance(value.get("status"), str)
            and isinstance(value.get("sessionId"), str)
            and isinstance(value.get("usage"), dict)
        ):
            return value
    return None


def _record_usage(context: AgentContext, raw_usage: Any) -> dict[str, Any]:
    usage = raw_usage if isinstance(raw_usage, dict) else {}
    input_tokens = _optional_int(usage.get("inputTokens"))
    output_tokens = _optional_int(usage.get("outputTokens"))
    cache_read_tokens = _optional_int(usage.get("cacheReadTokens"))
    cache_write_tokens = _optional_int(usage.get("cacheWriteTokens"))
    cache_tokens = sum(value for value in (cache_read_tokens, cache_write_tokens) if value is not None)
    if input_tokens is not None:
        context.n_input_tokens = input_tokens
    if output_tokens is not None:
        context.n_output_tokens = output_tokens
    if any(value is not None for value in (cache_read_tokens, cache_write_tokens)):
        context.n_cache_tokens = cache_tokens
    cost_usd = usage.get("costUsd")
    if isinstance(cost_usd, Real) and not isinstance(cost_usd, bool):
        context.cost_usd = float(cost_usd)
    return {
        key: usage[key]
        for key in (
            "calls",
            "inputTokens",
            "outputTokens",
            "totalTokens",
            "reasoningTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "costUsd",
            "pricingKnown",
        )
        if key in usage
    }


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _tail(value: str | None, limit: int = 1_000) -> str:
    return (value or "").strip()[-limit:]
