"""Harbor external-agent adapter for Biny's headless CLI.

The adapter packages the current Biny CLI once on the host, uploads that
package into each Harbor task environment, and runs ``biny run`` there. The
task verifier remains owned by Harbor/Terminal-Bench; Biny's own completion
text is never used as the benchmark score.
"""

from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import platform
import shlex
import stat
import subprocess
import sys
import tarfile
import threading
import time
import tomllib
from typing import Any, AsyncIterator
from urllib.parse import urlsplit, urlunsplit

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_CACHE = REPO_ROOT / ".agent" / "harbor"
PACKAGE_LOCK = threading.Lock()
PACKAGE_FILE_LOCK = PACKAGE_CACHE / ".biny-package.lock"
RUNTIME_CACHE_LOCK = asyncio.Lock()
RUNTIME_CACHE_FILE_LOCK = PACKAGE_CACHE / ".biny-runtime.lock"
# 模型/provider 表放在数据文件里，adapter 本身不认识任何具体模型。
# 接新模型有两条路：改 model-presets.json，或者直接给 BINY_EVAL_* 环境变量（后者一行代码都不用动）。
PRESETS_PATH = Path(__file__).with_name("model-presets.json")
PRESETS = json.loads(PRESETS_PATH.read_text())
ENV_DRIVEN = PRESETS["envDriven"]
DEFAULT_MODEL = PRESETS["defaultAlias"]
# 当前依赖树包含要求 Node >=22.19.0 的包；旧版本会把安装/启动错误误计为任务失败。
NODE_VERSION = "22.19.0"
NODE_MIN_MAJOR, NODE_MIN_MINOR = (int(part) for part in NODE_VERSION.split(".")[:2])
ADAPTER_VERSION = "0.2.5"
DEFAULT_FINALIZATION_RESERVE_RATIO = 0.15
PROVIDER_ENV_NAMES = (
    "COMMANDCODE_API_KEY",
    "SUB2API_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "MOONSHOT_API_KEY",
    "DASHSCOPE_API_KEY",
    "XAI_API_KEY",
    "OPENCODE_GO_KEY",
)


class BinyAgent(BaseAgent):
    """Run Biny headlessly inside a Harbor task environment."""

    @staticmethod
    def name() -> str:
        return "biny"

    def version(self) -> str | None:
        return ADAPTER_VERSION

    async def setup(self, environment: BaseEnvironment) -> None:
        package_path = ensure_package()
        await environment.upload_file(package_path, "/tmp/biny-agent.tgz")

        # 任务镜像可能自带 node（实测有 18.x）。只判断「命令是否存在」会误以为运行时
        # 已就绪，biny 随后就因缺 node:sqlite 直接崩。这里按版本判断：低于 22.19 一律装
        # portable node 到 /opt/node，且后续命令统一优先用 /opt/node/bin。
        node_check = await environment.exec(
            "export PATH=/opt/node/bin:$PATH; "
            "node -e 'const [maj, min] = process.versions.node.split(\".\").map(Number); "
            f"process.exit(maj > {NODE_MIN_MAJOR} "
            f"|| (maj === {NODE_MIN_MAJOR} && min >= {NODE_MIN_MINOR}) ? 0 : 1)' "
            "&& command -v npm"
        )
        if node_check.return_code != 0:
            architecture = await environment.exec("uname -m")
            node_archive = ensure_node_archive((architecture.stdout or "").strip())
            await environment.upload_file(node_archive, "/tmp/biny-node.tar.gz")
            install = await environment.exec(
                "export PATH=/opt/node/bin:$PATH; "
                "mkdir -p /opt/node && "
                "tar -xzf /tmp/biny-node.tar.gz --strip-components=1 -C /opt/node && "
                "/opt/node/bin/node --version && /opt/node/bin/npm --version",
                timeout_sec=600,
                user="root",
            )
            if install.return_code != 0:
                raise RuntimeError(format_exec_error("installing the portable Node.js runtime", install))

        # 依赖树装好之后与源码无关：打包缓存到宿主机，后续容器直接解压，
        # setup 阶段就不再碰网络——容器网络抖一下不会再毁掉整道题。
        package_sha256 = hashlib.sha256(package_path.read_bytes()).hexdigest()
        runtime_cache = PACKAGE_CACHE / f"biny-runtime-{package_sha256[:16]}.tgz"
        restored_from_cache = False
        async with runtime_cache_guard():
            runtime_source = (
                runtime_cache if runtime_cache.exists() else _find_runtime_cache(package_path)
            )
            if runtime_source is not None:
                await environment.upload_file(runtime_source, "/tmp/biny-runtime.tgz")
                restored_from_cache = True
            else:
                npm_retry_env = (
                    "npm_config_fetch_retries=6 "
                    "npm_config_fetch_retry_factor=2 "
                    "npm_config_fetch_retry_mintimeout=2000 "
                    "npm_config_fetch_retry_maxtimeout=120000 "
                )
                # 容器 DNS 走宿主 Clash 的 fake-ip，请求会偶发丢包（实测 ~2-7%）。
                # npm 默认只重试 2 次，而装依赖要发上百个请求，一次抖动就放大成整题报废：
                # 观察到的失败都是 setup 阶段 "npm error network"。这里对齐 zai_bench 已验证的
                # 重试预算，并在外层再兜两轮，避免把网络抖动记账成模型失败。
                for attempt in range(1, 4):
                    install = await environment.exec(
                        "export PATH=/opt/node/bin:$PATH; "
                        f"{npm_retry_env}"
                        "mkdir -p /opt/biny && "
                        "npm install --prefix /opt/biny --omit=dev --ignore-scripts "
                        "--no-audit --no-fund /tmp/biny-agent.tgz",
                        timeout_sec=1200,
                        user="root",
                    )
                    if install.return_code == 0:
                        break
                    if attempt < 3:
                        logger.warning(
                            "Biny dependency install failed (attempt %d/3), retrying: %s",
                            attempt,
                            format_exec_error("installing Biny", install)[-500:],
                        )
                if install.return_code != 0:
                    raise RuntimeError(format_exec_error("installing Biny", install))
                # 缓存要串行且原子落盘，否则并发 worker 可能读到半个 tarball。
                packed = await environment.exec(
                    "tar -czf /tmp/biny-runtime.tgz -C /opt biny",
                    timeout_sec=900,
                    user="root",
                )
                if packed.return_code:
                    raise RuntimeError(format_exec_error("caching the Biny runtime", packed))
                temporary_cache = runtime_cache.with_name(
                    f".{runtime_cache.name}.{os.getpid()}.tmp"
                )
                try:
                    await environment.download_file("/tmp/biny-runtime.tgz", temporary_cache)
                    temporary_cache.replace(runtime_cache)
                finally:
                    temporary_cache.unlink(missing_ok=True)

        if restored_from_cache:
            restored = await environment.exec(
                "tar -xzf /tmp/biny-runtime.tgz -C /opt",
                timeout_sec=900,
                user="root",
            )
            if restored.return_code:
                raise RuntimeError(
                    format_exec_error("restoring the cached Biny runtime", restored)
                )

        # 缓存里的 @biny012/biny 是生成缓存时的旧包。依赖可以复用，但执行代码必须来自
        # 本轮刚打出的 package，否则源码-only 的修复会被旧缓存静默吞掉。
        overlaid = await environment.exec(
            "export PATH=/opt/node/bin:$PATH; "
            "rm -rf /opt/biny/node_modules/@biny012/biny && "
            "mkdir -p /opt/biny/node_modules/@biny012/biny && "
            "tar -xzf /tmp/biny-agent.tgz --strip-components=1 "
            "-C /opt/biny/node_modules/@biny012/biny && "
            "ln -sf /opt/biny/node_modules/.bin/biny /usr/local/bin/biny && "
            "/usr/local/bin/biny --version",
            timeout_sec=300,
            user="root",
        )
        if overlaid.return_code:
            raise RuntimeError(
                format_exec_error("overlaying the current Biny package", overlaid)
            )

        cwd = await task_workdir(environment)
        # biny 的模型约束：defaultModel 指向的模型必须存在于"全局" config（默认 ~/.biny/config.json）。
        # 我们通过 BINY_AGENT_DIR 把全局目录重定向到 /opt/biny-global，并把含模型定义的完整
        # config 写进去。这样项目级无需任何多余文件，biny run 也能看到 opencode-go 等新模型。
        global_dir = "/opt/biny-global"
        await environment.exec(
            f"mkdir -p {shlex.quote(global_dir)}",
            user="root",
        )
        model_alias = resolve_model_alias(self.model_name)
        config = make_config(model_alias, self.extra_env)
        agent_exec_timeout = _agent_exec_timeout({**os.environ, **self.extra_env})
        # Harbor owns each trial environment. The container is stopped after the
        # verifier (shared mode) or immediately after the agent (separate mode).
        self._managed_process_lifetime = managed_process_lifetime()
        write_evaluation_provenance(
            self.logs_dir,
            model_alias,
            config,
            agent_exec_timeout,
            package_sha256,
            self._managed_process_lifetime,
        )
        await write_remote_text(
            environment,
            global_dir,
            "config.json",
            json.dumps(config, indent=2) + "\n",
        )

        # 89 道题里有 82 道的 tests/test.sh 靠 `uvx` 跑判分，而它们默认是现场从 GitHub
        # 拉 uv 安装脚本。容器网络一抖（走宿主 Clash 代理，实测偶发 TLS 失败）verifier
        # 就根本起不来 —— 记成 reward=0，但这不是模型没做出来。这里把预置的 uv/pytest
        # 直接铺进容器，判分不再依赖外网。zai_bench 一直这么做，通用 adapter 之前漏了。
        verifier_arch = (await environment.exec("uname -m")).stdout.strip()
        if verifier_arch in {"x86_64", "amd64"}:
            await environment.upload_file(
                PACKAGE_CACHE / "zai-verifier.tgz", "/tmp/biny-verifier.tgz"
            )
            # 预置包自带 glibc 2.17 基线的 CPython，直接用它就绕开「镜像自带 glibc 低于
            # 预置 Python 基线」这类版本错配；/root/.local/bin 是 test.sh 写死的 uv 路径。
            check = await environment.exec(
                "tar -xzf /tmp/biny-verifier.tgz -C / && "
                "/opt/biny-verifier-python/bin/python3.13 -c "
                '"import pytest, ctrf; print(pytest.__version__)" && '
                "ln -sf /opt/biny-verifier-python/bin/pytest "
                "/usr/local/bin/biny-verifier-pytest && "
                "/usr/local/bin/biny-verifier-pytest --version && "
                "/root/.local/bin/uvx --version",
                timeout_sec=180,
                user="root",
            )
            if check.return_code:
                # 铺不上不判死整道题：撤掉启动器，让 test.sh 退回自己的联网引导，
                # 同时留下证据，方便事后把 infra 失败和能力失败分开统计。
                reason = (check.stderr or check.stdout or "")[-2000:]
                await environment.exec(
                    "rm -f /usr/local/bin/biny-verifier-pytest",
                    timeout_sec=15,
                    user="root",
                )
                await write_remote_text(
                    environment,
                    global_dir,
                    "verifier-deps-fallback.txt",
                    "Verifier toolchain unavailable; falling back to the task test.sh.\n"
                    + reason,
                )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        cwd = await task_workdir(environment)
        run_env = agent_environment(self.extra_env)
        run_env.pop("BINY_MANAGED_PROCESS_LIFETIME", None)
        process_lifetime = managed_process_lifetime()
        run_env["BINY_MANAGED_PROCESS_LIFETIME"] = process_lifetime
        # Harbor 已按 task.agent.timeout_sec 和 multiplier 包住整个 run；默认不在
        # environment.exec 再加第二道固定上限。只有显式设置此变量才增加内部 timeout。
        agent_exec_timeout = _agent_exec_timeout({**os.environ, **self.extra_env})
        # 让 biny 把 /opt/biny-global 当作全局配置/agent 目录，从而读到我们在 setup 写下的 model。
        run_env["BINY_AGENT_DIR"] = "/opt/biny-global"
        time_budget = task_time_budget(self.logs_dir, self.session_id)
        command_flags = "--json"
        if time_budget is not None:
            deadline_at_ms, reserve_ms = time_budget
            run_env["BINY_RUN_DEADLINE_AT_MS"] = str(deadline_at_ms)
            run_env["BINY_RUN_FINALIZATION_RESERVE_MS"] = str(reserve_ms)
            command_flags += (
                f" --deadline-at-ms {deadline_at_ms}"
                f" --finalization-reserve-ms {reserve_ms}"
            )
        encoded_instruction = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        command = (
            "export PATH=/opt/node/bin:$PATH; "
            "mkdir -p .agent && "
            f"printf %s {shlex.quote(encoded_instruction)} | base64 -d > .agent/harbor-instruction.txt && "
            # "--" 必须有：有的题 instruction 正好以 markdown 的 "- " 开头
            # （实测 pytorch-model-recovery），不加就会被 commander 当成选项，
            # 报 "error: unknown option '- You are given ...'"，整题作废。
            f'biny run {command_flags} -- "$(cat .agent/harbor-instruction.txt)"'
        )
        result = await environment.exec(
            command,
            cwd=cwd,
            env=run_env,
            timeout_sec=agent_exec_timeout,
        )

        record = {
            "model": resolve_model_alias(self.model_name),
            "agent_exec_timeout_sec": agent_exec_timeout,
            "deadline_at_ms": (
                time_budget[0] if time_budget is not None else None
            ),
            "finalization_reserve_ms": (
                time_budget[1] if time_budget is not None else None
            ),
            "deadline_source": (
                "task.agent.timeout_sec * BINY_EVAL_AGENT_TIMEOUT_MULTIPLIER"
                if time_budget is not None
                else "unavailable-task-timeout-metadata"
            ),
            "managed_process_lifetime": process_lifetime,
            "return_code": result.return_code,
            "stdout": result.stdout or "",
            "stderr": result.stderr or "",
        }
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "biny-result.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        context.metadata = {
            "agent": "biny",
            "model": record["model"],
            "agent_exec_timeout_sec": agent_exec_timeout,
            "deadline_at_ms": record["deadline_at_ms"],
            "finalization_reserve_ms": record["finalization_reserve_ms"],
            "deadline_source": record["deadline_source"],
            "managed_process_lifetime": process_lifetime,
            "return_code": result.return_code,
            "stdout_tail": (result.stdout or "")[-8_000:],
            "stderr_tail": (result.stderr or "")[-8_000:],
        }
        if result.return_code != 0:
            raise RuntimeError(format_exec_error("running Biny", result))


def ensure_package() -> Path:
    """Create a production package containing the current CLI and its deps."""

    PACKAGE_CACHE.mkdir(parents=True, exist_ok=True)
    # Harbor 的并发 trial 可能由不同 Python 进程执行；threading.Lock 只覆盖单进程，
    # 不能保护共享的宿主机 package cache。文件锁让所有 worker 串行检查/打包，
    # 后续 worker 直接复用同一份已经完成的 tarball。
    with PACKAGE_FILE_LOCK.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            with PACKAGE_LOCK:
                # 缓存目录同时放 Node、verifier 和 runtime tarball，不能把最新的任意 tgz
                # 误当成 Biny package 上传。
                existing = sorted(
                    PACKAGE_CACHE.glob("biny012-biny-*.tgz"),
                    key=lambda path: path.stat().st_mtime,
                    reverse=True,
                )
                source_fingerprint = _package_source_fingerprint(REPO_ROOT)
                for package_path in existing:
                    try:
                        manifest = json.loads(
                            _package_manifest_path(package_path).read_text(
                                encoding="utf-8"
                            )
                        )
                    except (OSError, json.JSONDecodeError):
                        continue
                    if not isinstance(manifest, dict):
                        continue
                    if (
                        manifest.get("sourceFingerprint") == source_fingerprint
                        and manifest.get("packageSha256") == _sha256_file(package_path)
                    ):
                        return package_path

                try:
                    subprocess.run(
                        ["pnpm", "pack", "--pack-destination", str(PACKAGE_CACHE)],
                        cwd=REPO_ROOT,
                        check=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                    )
                except subprocess.CalledProcessError as error:
                    output = error.stdout or error.output or ""
                    if isinstance(output, bytes):
                        output = output.decode("utf-8", errors="replace")
                    detail = output[-8_000:].strip()
                    message = f"pnpm pack failed with exit status {error.returncode}."
                    if detail:
                        message += f"\n{detail}"
                    raise RuntimeError(message) from error
                packages = sorted(
                    PACKAGE_CACHE.glob("biny012-biny-*.tgz"),
                    key=lambda path: path.stat().st_mtime,
                    reverse=True,
                )
                if not packages:
                    raise RuntimeError(f"pnpm pack did not create a package in {PACKAGE_CACHE}")
                package_path = packages[0]
                if _package_source_fingerprint(REPO_ROOT) != source_fingerprint:
                    raise RuntimeError("Biny package inputs changed while pnpm pack was running.")
                _write_package_manifest(
                    package_path,
                    source_fingerprint,
                    _sha256_file(package_path),
                )
                return package_path
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _package_source_fingerprint(repo_root: Path) -> str:
    """Hash package/build inputs so resource edits cannot reuse an old tarball."""

    input_paths = (
        "package.json",
        "pnpm-lock.yaml",
        ".gitignore",
        ".npmignore",
        ".npmrc",
        "tsconfig.json",
        "src",
        "benchmarks",
        "native/calendar-reader",
        "scripts/clean-dist.mjs",
        "scripts/build-calendar-sidecar.mjs",
        "scripts/copy-bundled-skills.mjs",
        "scripts/copy-browser-extension.mjs",
    )
    files: set[Path] = set()
    for relative in input_paths:
        path = repo_root / relative
        if path.is_dir():
            files.update(
                item
                for item in path.rglob("*")
                if item.is_file()
                and item.name != ".DS_Store"
                and item.suffix != ".pyc"
                and "__pycache__" not in item.parts
            )
        elif path.is_file():
            files.add(path)

    digest = hashlib.sha256()
    digest.update(f"{platform.system()}\0{platform.machine()}\0".encode())
    for path in sorted(files, key=lambda item: item.relative_to(repo_root).as_posix()):
        relative = path.relative_to(repo_root).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(stat.S_IMODE(path.stat().st_mode)).encode("ascii"))
        digest.update(b"\0")
        with path.open("rb") as source_file:
            for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def _package_manifest_path(package_path: Path) -> Path:
    return package_path.with_name(f"{package_path.name}.manifest.json")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_package_manifest(
    package_path: Path, source_fingerprint: str, package_sha256: str
) -> None:
    manifest_path = _package_manifest_path(package_path)
    temporary_path = manifest_path.with_name(f".{manifest_path.name}.{os.getpid()}.tmp")
    try:
        temporary_path.write_text(
            json.dumps(
                {
                    "sourceFingerprint": source_fingerprint,
                    "packageSha256": package_sha256,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        temporary_path.replace(manifest_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def ensure_node_archive(architecture: str) -> Path:
    normalized = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(architecture)
    if normalized is None:
        raise RuntimeError(f"Unsupported task container architecture: {architecture or '(unknown)'}")
    archive = PACKAGE_CACHE / f"node-v{NODE_VERSION}-linux-{normalized}.tar.gz"
    if archive.is_file():
        return archive
    url = f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-{normalized}.tar.gz"
    subprocess.run(
        ["curl", "-fL", "--retry", "3", "--output", str(archive), url],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return archive


async def task_workdir(environment: BaseEnvironment) -> str:
    result = await environment.exec("pwd")
    if result.return_code != 0 or not (result.stdout or "").strip():
        raise RuntimeError(format_exec_error("locating the task workdir", result))
    return (result.stdout or "").strip().splitlines()[-1]


async def write_remote_text(environment: BaseEnvironment, cwd: str, name: str, value: str) -> None:
    encoded = base64.b64encode(value.encode("utf-8")).decode("ascii")
    result = await environment.exec(
        f"printf %s {shlex.quote(encoded)} | base64 -d > {shlex.quote(name)}",
        cwd=cwd,
    )
    if result.return_code != 0:
        raise RuntimeError(format_exec_error(f"writing {name}", result))


def resolve_model_alias(model_name: str | None) -> str:
    """把 harbor 的 --model 解析成容器内 config 使用的模型别名。

    给了 BINY_EVAL_MODEL 就完全绕过预设表——接新模型只要传几个环境变量，
    不用改这个文件，更不用为它单独写一份 adapter。
    """

    if os.environ.get(ENV_DRIVEN["model"]):
        return (
            os.environ.get(ENV_DRIVEN["alias"])
            or os.environ.get(ENV_DRIVEN["provider"])
            or "eval"
        ).strip()
    raw = (model_name or os.environ.get("BINY_MODEL") or DEFAULT_MODEL).strip()
    alias = raw.rsplit("/", maxsplit=1)[-1]
    return alias if alias in PRESETS["presets"] else DEFAULT_MODEL


def model_provider(model_alias: str, runtime_env: dict[str, str] | None = None) -> dict[str, str]:
    """解析出 provider 配置。环境变量优先，其次查 model-presets.json。"""

    env = {**os.environ, **(runtime_env or {})}
    explicit_model = env.get(ENV_DRIVEN["model"])
    if explicit_model:
        return {
            "alias": (env.get(ENV_DRIVEN["provider"]) or "eval").strip(),
            "type": (env.get(ENV_DRIVEN["type"]) or "openai-compatible").strip(),
            "baseUrl": (env.get(ENV_DRIVEN["baseUrl"]) or "").strip(),
            "apiKeyEnv": (env.get(ENV_DRIVEN["apiKeyEnv"]) or "BINY_EVAL_API_KEY").strip(),
            "model": explicit_model.strip(),
            "apiBackend": (env.get(ENV_DRIVEN["apiBackend"]) or "chat_completions").strip(),
        }

    preset = PRESETS["presets"].get(model_alias) or PRESETS["presets"][DEFAULT_MODEL]
    resolved = {
        "alias": preset["provider"],
        "type": preset["type"],
        "baseUrl": preset["baseUrl"],
        "apiKeyEnv": preset["apiKeyEnv"],
        # deepseek 这个兜底预设不写死 model id，直接用别名当 model。
        "model": preset.get("model") or model_alias,
        "apiBackend": preset["apiBackend"],
    }
    for field, env_name in (preset.get("envOverrides") or {}).items():
        if env.get(env_name):
            resolved[field] = env[env_name].strip()
    if env.get("BINY_GROK_API_KEY_ENV") and resolved["alias"] == "xai":
        resolved["apiKeyEnv"] = env["BINY_GROK_API_KEY_ENV"]
    return resolved


def make_config(model_alias: str, runtime_env: dict[str, str] | None = None) -> dict[str, Any]:
    provider = model_provider(model_alias, runtime_env)
    is_reasoning_model = provider["type"] != "openai-compatible"
    reasoning_effort = _reasoning_effort(runtime_env)
    if ENV_DRIVEN["reasoning"] in {**os.environ, **(runtime_env or {})}:
        is_reasoning_model = _env_flag(
            ENV_DRIVEN["reasoning"], is_reasoning_model, runtime_env
        )
    provider_config: dict[str, Any] = {
        "type": provider["type"],
        "baseUrl": provider["baseUrl"],
        "apiKeyEnv": provider["apiKeyEnv"],
    }
    if provider["type"] == "openai-compatible":
        provider_config["apiBackend"] = provider["apiBackend"]
    if provider["type"] == "openai-compatible":
        provider_config["compatibility"] = {
            "supportsReasoning": is_reasoning_model
        }
    # 配置 schema 将 Provider 重试次数限制在 6；超出上限会使每道任务在启动时校验失败。
    # 这里使用允许的最大次数，降低临时请求故障导致整题失败的概率。
    provider_config["retry"] = {"maxAttempts": 6, "initialDelayMs": 1000, "maxDelayMs": 15000}
    # deepseek-v4-flash 这类模型没有真实 thinking；强行走 reasoning 会让模型空想而不动手，
    # 这是此前评测空转/高步数的温床。openai-compatible Provider 一律关闭全局 thinking。
    model_capabilities = {"tools": True, "streaming": True}
    model_config: dict[str, Any] = {
        "provider": provider["alias"],
        "model": provider["model"],
        "displayName": model_alias,
        "supportsTools": True,
        "capabilities": model_capabilities,
        "contextWindow": _context_window(model_alias, runtime_env),
    }
    if is_reasoning_model:
        model_config["capabilities"]["reasoning"] = True
        model_config["thinkingLevelMap"] = {"off": "none", "high": "high", "max": "max"}
        model_config["reasoning"] = {
            "efforts": ["high", "max"],
            "defaultEffort": reasoning_effort,
            "mapping": {"high": "high", "max": "max"},
        }
    # Terminal-Bench 是工具调用密集型任务，放宽步数和时长预算。
    agent_config = {
        "softStepLimit": 100_000,
        "hardStepLimit": 100_000,
        # 工具调用数不单独限次，交由 Harbor 的 task.toml 时限终止长任务。
        "maxToolCalls": 100_000,
        "maxRepeatedActions": 3,
        "maxConcurrentTools": 4,
        "maxQueuedToolCalls": 128,
    }
    # 容器是 linux，没有 seatbelt。permission.denyPaths 只要非空，Bash 工具就会被
    # sandboxCommand 直接抛错（"Cannot enforce command sandbox restrictions on linux"），
    # 整题失明。注意必须显式给空数组：省略该键会回落到 PermissionManager 内置的
    # [".env", ".ssh/"]，照样非空。评测容器是一次性的，这里不做路径拒绝。
    permission_config = {
        "mode": "full-access",
        "allowPaths": [],
        "denyPaths": [],
        "criticalAlwaysAsk": False,
    }
    return {
        "format": "biny-config",
        "configVersion": 1,
        "defaultModel": model_alias,
        "providers": {provider["alias"]: provider_config},
        "models": {model_alias: model_config},
        "thinking": {"enabled": is_reasoning_model, "effort": reasoning_effort},
        "agent": agent_config,
        "permission": permission_config,
        "workspace": {
            "ignore": ["node_modules", ".git", ".agent", ".env", ".DS_Store"],
        },
        "context": {
            "maxTurnToolResultBytes": 16 * 1024 * 1024,
            "instructionsMaxBytes": 128 * 1024,
            "compaction": {"enabled": False},
            "memory": {"enabled": False},
        },
        "web": {"search": {"enabled": False}},
        "telemetry": {"enabled": False},
        "extensions": {"mcp": {}, "skills": [], "plugins": [], "subagent": {"enabled": False}},
    }


def agent_environment(extra_env: dict[str, str]) -> dict[str, str]:
    configured = {os.environ.get("BINY_GROK_API_KEY_ENV", "GROK_API_KEY")}
    # 环境变量驱动模式下，密钥变量名是运行时给的，也要一起带进容器，
    # 否则容器里 apiKeyEnv 指向的变量是空的。
    explicit_key_env = os.environ.get(ENV_DRIVEN["apiKeyEnv"])
    if explicit_key_env:
        configured.add(explicit_key_env.strip())
    values = {
        name: os.environ[name]
        for name in (*PROVIDER_ENV_NAMES, *sorted(configured))
        if os.environ.get(name)
    }
    values.update(extra_env)
    return values


def format_exec_error(action: str, result: Any) -> str:
    output = "\n".join(part for part in (result.stdout or "", result.stderr or "") if part)
    return f"Failed {action} (exit {result.return_code}): {output[-4_000:]}"


def _dependency_manifest(package: Path, member_name: str) -> str:
    """读取包的依赖清单，用于复用与源码哈希无关的 runtime 缓存。"""

    with tarfile.open(package, "r:gz") as archive:
        member = archive.getmember(member_name)
        content = archive.extractfile(member)
        if content is None:
            raise RuntimeError(f"Could not read dependency manifest from {package}.")
        manifest = json.load(content)
    return json.dumps(
        {
            "dependencies": manifest.get("dependencies", {}),
            "optionalDependencies": manifest.get("optionalDependencies", {}),
        },
        sort_keys=True,
        separators=(",", ":"),
    )


@asynccontextmanager
async def runtime_cache_guard() -> AsyncIterator[None]:
    """同一进程和跨进程都只允许一个 worker 生成或挑选 runtime 缓存。"""

    PACKAGE_CACHE.mkdir(parents=True, exist_ok=True)
    async with RUNTIME_CACHE_LOCK:
        with RUNTIME_CACHE_FILE_LOCK.open("a+") as lock_file:
            await asyncio.to_thread(fcntl.flock, lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _find_runtime_cache(package: Path) -> Path | None:
    """只复用依赖清单完全一致的 runtime，避免源码包哈希变化触发重复安装。"""

    expected = _dependency_manifest(package, "package/package.json")
    for candidate in sorted(PACKAGE_CACHE.glob("biny-runtime-*.tgz")):
        try:
            actual = _dependency_manifest(
                candidate,
                "biny/node_modules/@biny012/biny/package.json",
            )
        except (KeyError, OSError, tarfile.TarError, json.JSONDecodeError):
            continue
        if actual == expected:
            return candidate
    return None


def _env_flag(
    name: str, default: bool, runtime_env: dict[str, str] | None = None
) -> bool:
    raw = (runtime_env or {}).get(name, os.environ.get(name))
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _reasoning_effort(runtime_env: dict[str, str] | None = None) -> str:
    raw = (runtime_env or {}).get(
        "BINY_EVAL_REASONING_EFFORT",
        os.environ.get("BINY_EVAL_REASONING_EFFORT", "high"),
    )
    effort = raw.strip().lower()
    if effort not in {"high", "max"}:
        raise ValueError("BINY_EVAL_REASONING_EFFORT must be high or max")
    return effort


def task_time_budget(
    logs_dir: Path,
    session_id: str | None,
    environ: dict[str, str] | None = None,
    now_ms: int | None = None,
) -> tuple[int, int] | None:
    """Resolve this trial's effective agent deadline from its task config."""

    env = {**os.environ, **(environ or {})}
    trial_name = logs_dir.parent.name
    task_name = trial_name.split("__", maxsplit=1)[0]
    if not task_name and session_id:
        task_name = session_id.split("__", maxsplit=1)[0]
    if not task_name:
        return None
    tasks_root = Path(
        env.get("BINY_EVAL_TASKS_DIR")
        or REPO_ROOT / ".agent" / "harbor" / "tb21-tasks-full" / "tasks"
    )
    task_file = tasks_root / task_name / "task.toml"
    try:
        task_config = tomllib.loads(task_file.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return None
    configured_timeout = task_config.get("agent", {}).get("timeout_sec")
    if not isinstance(configured_timeout, (int, float)) or isinstance(
        configured_timeout, bool
    ) or configured_timeout <= 0:
        return None
    try:
        multiplier = float(env.get("BINY_EVAL_AGENT_TIMEOUT_MULTIPLIER", "1"))
        reserve_ratio = float(
            env.get(
                "BINY_EVAL_FINALIZATION_RESERVE_RATIO",
                str(DEFAULT_FINALIZATION_RESERVE_RATIO),
            )
        )
    except ValueError as error:
        raise ValueError("Harbor timeout multiplier and reserve ratio must be numeric") from error
    if multiplier <= 0:
        raise ValueError("BINY_EVAL_AGENT_TIMEOUT_MULTIPLIER must be positive")
    if not 0 <= reserve_ratio <= 0.2:
        raise ValueError(
            "BINY_EVAL_FINALIZATION_RESERVE_RATIO must be between 0 and 0.2"
        )
    budget_ms = int(configured_timeout * multiplier * 1_000)
    reserve_ms = int(budget_ms * reserve_ratio)
    start_ms = int(time.time() * 1_000) if now_ms is None else now_ms
    return start_ms + budget_ms, reserve_ms


def _context_window(
    model_alias: str, runtime_env: dict[str, str] | None = None
) -> int:
    env = {**os.environ, **(runtime_env or {})}
    configured = (env.get(ENV_DRIVEN["contextWindow"]) or "").strip()
    if configured:
        try:
            context_window = int(configured)
        except ValueError as error:
            raise ValueError(
                f"{ENV_DRIVEN['contextWindow']} must be a positive integer"
            ) from error
        if context_window <= 0:
            raise ValueError(f"{ENV_DRIVEN['contextWindow']} must be a positive integer")
        return context_window

    preset = PRESETS["presets"].get(model_alias) or {}
    preset_context_window = preset.get("contextWindow")
    if isinstance(preset_context_window, int) and not isinstance(
        preset_context_window, bool
    ):
        return preset_context_window
    if model_alias in {"grok", "grok-4.5", "opencode-go-deepseek-v4-flash"}:
        return 1_000_000
    return 128_000


def _agent_exec_timeout(runtime_env: dict[str, str]) -> int | None:
    configured = runtime_env.get("BINY_AGENT_EXEC_TIMEOUT_SEC")
    if configured is None or not configured.strip():
        return None
    try:
        timeout = int(configured)
    except ValueError as error:
        raise ValueError("BINY_AGENT_EXEC_TIMEOUT_SEC must be a positive integer") from error
    if timeout <= 0:
        raise ValueError("BINY_AGENT_EXEC_TIMEOUT_SEC must be a positive integer")
    return timeout


def managed_process_lifetime() -> str:
    """A disposable Harbor trial environment owns services beyond one CLI run."""

    return "execution-environment"


def write_evaluation_provenance(
    logs_dir: Path,
    model_alias: str,
    config: dict[str, Any],
    agent_exec_timeout_sec: int | None,
    package_sha256: str | None = None,
    process_lifetime: str = "runtime",
    package_source_fingerprint: str | None = None,
) -> Path:
    """Save effective per-trial limits without persisting endpoint URL credentials."""

    model = config["models"][model_alias]
    safe_config = json.loads(json.dumps(config))
    for provider in safe_config.get("providers", {}).values():
        base_url = provider.get("baseUrl")
        if isinstance(base_url, str) and base_url:
            provider["baseUrl"] = _redact_base_url(base_url)
    canonical_config = json.dumps(
        safe_config, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    lock_file = REPO_ROOT / "pnpm-lock.yaml"
    record = {
        "adapterVersion": ADAPTER_VERSION,
        "adapterSha256": _sha256_file(Path(__file__)),
        "fastVerifierSha256": _sha256_file(Path(__file__).with_name("fast_verifier.py")),
        "modelAlias": model_alias,
        "contextWindow": model["contextWindow"],
        "agentExecTimeoutSec": agent_exec_timeout_sec,
        "agentExecTimeoutSource": (
            "explicit-BINY_AGENT_EXEC_TIMEOUT_SEC"
            if agent_exec_timeout_sec is not None
            else "harbor-trial-deadline"
        ),
        "binyPackageSha256": package_sha256,
        "packageSourceFingerprint": package_source_fingerprint
        or _package_source_fingerprint(REPO_ROOT),
        "pnpmLockSha256": _sha256_file(lock_file) if lock_file.is_file() else None,
        "configSha256": hashlib.sha256(canonical_config).hexdigest(),
        "managedProcessLifetime": process_lifetime,
        "runtime": {
            "platform": platform.platform(),
            "architecture": platform.machine(),
            "pythonVersion": sys.version.split()[0],
            "nodeVersion": NODE_VERSION,
        },
        "binyConfig": safe_config,
    }
    logs_dir.mkdir(parents=True, exist_ok=True)
    path = logs_dir / "biny-evaluation.json"
    path.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return path


def _redact_base_url(value: str) -> str:
    """Keep the endpoint route for audit while dropping URL credentials and query data."""

    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return "[redacted invalid URL]"
    if not parsed.scheme or not hostname:
        return "[redacted invalid URL]"
    host = f"[{hostname}]" if ":" in hostname else hostname
    if port is not None:
        host = f"{host}:{port}"
    return urlunsplit((parsed.scheme, host, parsed.path, "", ""))
