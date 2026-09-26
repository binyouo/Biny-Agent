"""离线快速 verifier：保留任务测试本体，跳过重复的联网依赖引导。

Terminal-Bench 的 ``tests/test.sh`` 会在真正的 pytest 前重复执行 ``apt-get``、
在线安装 uv，再让 ``uvx`` 联网解析 pytest。评测包里已经预置了一份 glibc 2.17
基线的 CPython + pytest + pytest-json-ctrf，这里把可离线复现的引导步骤换掉，
测试参数、断言和 reward 写入逻辑一律不动。

只有 Python 依赖精确匹配预置集合才改写。当前额外允许 sshpass 这一项系统依赖，
单独安装它，避免同一条 apt 命令升级 curl 时被 Debian 镜像中的旧索引/已删除包卡住。
"""

from __future__ import annotations

import re
import shutil
import tempfile
from pathlib import Path

from harbor.models.verifier.result import VerifierResult
from harbor.verifier.verifier import Verifier


_PYTEST_BIN = "/usr/local/bin/biny-verifier-pytest"

# 随包预置的 Python 包（包名 -> 确切版本）。带版本号比对是刻意的：
# 只要任务 pin 的版本和预置的不一致，就不走离线路径，避免版本漂移悄悄改变判分。
_BUNDLED_REQUIREMENTS = {
    "pytest": "8.4.1",
    "pytest-json-ctrf": "0.3.5",
    "numpy": "2.3.1",
    "pillow": "11.2.1",
    "chess": "1.11.2",
}

# apt 里可以安全跳过的包：curl 只服务于被替换掉的 uv 安装器，
# python3-pillow 提供的 PIL 已经由预置 Python 覆盖。
_IGNORABLE_APT_PACKAGES = {"curl", "python3-pillow"}
_REQUIRED_APT_PACKAGES = {"sshpass"}

_APT_UPDATE = re.compile(r"^\s*apt-get\s+update\b")
_APT_INSTALL = re.compile(r"^\s*apt-get\s+install\b")
_PIP_INSTALL = re.compile(
    r"^\s*(?:uv\s+|python3?(?:\.\d+)?\s+-m\s+)?pip\s+install\b"
)
_UV_INSTALLER = re.compile(r"^\s*curl\s+-LsSf\s+https://astral\.sh/uv/[^|]+\|\s*sh")
_UV_ENV_SCRIPT = re.compile(r"^\s*source\s+\$HOME/\.local/bin/env\s*$")
_UVX_START = re.compile(r"^\s*uvx\s*\\?\s*$")


def _requirements(fragment: str) -> list[tuple[str, str]]:
    """从 ``-w`` / ``pip install`` 片段里取出 (包名, 版本) 对。

    版本取 ``==`` 后面的确切值；没有 ``==`` 时记为 ""，在比对时一律算不合格。
    """
    found: list[tuple[str, str]] = []
    for token in fragment.replace("\\", " ").split():
        if not token or token.startswith("-") or "://" in token or token.startswith("git+"):
            continue
        token = token.strip("'\"")
        match = re.match(r"([A-Za-z0-9_.\-]+)\s*==\s*([^,;\s]+)", token)
        if match:
            found.append((match.group(1).lower(), match.group(2)))
            continue
        name = re.split(r"[=<>!~\[]", token, maxsplit=1)[0].strip().lower()
        if name:
            found.append((name, ""))
    return found


def _only_bundled(fragment: str) -> bool:
    requirements = _requirements(fragment)
    if not requirements:
        return False
    return all(_BUNDLED_REQUIREMENTS.get(name) == version for name, version in requirements)


class FastVerifier(Verifier):
    """在固定离线依赖上执行原始测试脚本。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._fast_tests_dir: Path | None = None

    async def verify(self) -> VerifierResult:
        source_dir = self.task.paths.tests_dir
        temp_dir = Path(tempfile.mkdtemp(prefix="biny-fast-tests-"))
        self._fast_tests_dir = temp_dir
        try:
            shutil.copytree(source_dir, temp_dir, dirs_exist_ok=True)
            for script in temp_dir.rglob("test.sh"):
                _patch_test_script(script)
            return await super().verify()
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
            self._fast_tests_dir = None

    def _resolve_tests(self):
        if self._fast_tests_dir is None:
            raise RuntimeError("Fast verifier test directory is not prepared.")

        source_dirs, tests_source_dir, host_test_path = Verifier._resolve_tests(self)
        original_root = self.task.paths.tests_dir

        def remap(path: Path) -> Path:
            return self._fast_tests_dir / path.resolve().relative_to(original_root.resolve())

        return (
            [remap(path) for path in source_dirs],
            remap(tests_source_dir),
            remap(host_test_path),
        )


def _consume_logical(lines: list[str], index: int) -> tuple[list[str], int]:
    """按反斜杠续行把一条命令拼完整，返回 (各行原文, 下一行下标)。"""
    parts = [lines[index]]
    while parts[-1].rstrip().endswith("\\") and index + 1 < len(lines):
        index += 1
        parts.append(lines[index])
    return parts, index + 1


def _uvx_blocks(lines: list[str]) -> list[list[str]]:
    blocks: list[list[str]] = []
    index = 0
    while index < len(lines):
        if _UVX_START.match(lines[index]):
            block, index = _consume_logical(lines, index)
            blocks.append(block)
        else:
            index += 1
    return blocks


def _fast_eligible(lines: list[str]) -> bool:
    """判断整份 test.sh 是否完全能被预置依赖覆盖。"""
    blocks = _uvx_blocks(lines)
    if not blocks:
        return False

    for line in lines:
        if _APT_INSTALL.match(line):
            packages = {name for name, _ in _requirements(line.split("install", 1)[1])}
            if packages - _IGNORABLE_APT_PACKAGES - _REQUIRED_APT_PACKAGES:
                return False

    index = 0
    while index < len(lines):
        line = lines[index]
        if _PIP_INSTALL.match(line):
            parts, index = _consume_logical(lines, index)
            if not _only_bundled(" ".join(parts).split("install", 1)[1]):
                return False
            continue
        if _UVX_START.match(line):
            parts, index = _consume_logical(lines, index)
            specs = " ".join(re.findall(r"-w\s+(\S+)", " ".join(parts)))
            pytest_line = next(
                (item.strip() for item in parts if item.strip().startswith("pytest ")),
                None,
            )
            if pytest_line is None or not _only_bundled(specs):
                return False
            continue
        index += 1

    return True


def _patch_test_script(path: Path) -> None:
    """仅在预置工具确实存在时替换依赖引导，其他环境沿用任务脚本。"""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    eligible = _fast_eligible(lines)
    needs_sshpass = any(
        _APT_INSTALL.match(line)
        and "sshpass"
        in {name for name, _ in _requirements(line.split("install", 1)[1])}
        for line in lines
    )

    output: list[str] = []
    index = 0
    if lines and lines[0].startswith("#!"):
        # 保持 shebang 在首行，避免某些执行器直接启动脚本时丢失解释器选择。
        output.append(lines[0])
        index = 1

    output.extend(
        [
            "# Biny fast verifier: 根据容器实际架构选择预置或任务原始引导",
            f'if [ -x "{_PYTEST_BIN}" ]; then',
            "  export BINY_FAST_VERIFIER=1",
        ]
    )
    if eligible:
        # pytest 来自预置目录，把它排在任务镜像的 site-packages 前面，
        # 避免同名包被镜像里的旧版本抢先导入。
        output.append(
            "  export PYTHONPATH=/opt/biny-verifier-python/lib/python3.13/site-packages"
            ":/usr/local/lib/python3.13/site-packages${PYTHONPATH:+:$PYTHONPATH}"
        )
    else:
        # 未完全覆盖的任务仍需 uv 在线安装额外依赖，但 Python 本身已随工具链预置。
        output.append("  export UV_OFFLINE=false")
    output.extend(
        [
            "else",
            "  export BINY_FAST_VERIFIER=0",
            "  export UV_OFFLINE=false",
            # ARM64 等未铺预置解释器的架构，需要 uv 按原脚本下载指定 Python。
            "  export UV_PYTHON_DOWNLOADS=automatic",
            "fi",
        ]
    )

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if _UV_INSTALLER.match(line):
            parts, index = _consume_logical(lines, index)
            output.extend(
                [
                    'if [ "${BINY_FAST_VERIFIER:-0}" = 1 ]; then',
                    "  # uv 与 pytest 已随预置工具链安装",
                    "  :",
                    "else",
                    *[f"  {part.strip()}" for part in parts],
                    "fi",
                ]
            )
            continue

        if eligible and _APT_UPDATE.match(line) and not needs_sshpass:
            parts, index = _consume_logical(lines, index)
            output.extend(
                [
                    'if [ "${BINY_FAST_VERIFIER:-0}" = 1 ]; then',
                    "  # curl 仅用于 uv 安装器，快速路径无需联网",
                    "  :",
                    "else",
                    *[f"  {part.strip()}" for part in parts],
                    "fi",
                ]
            )
            continue

        if eligible and _APT_INSTALL.match(line):
            parts, index = _consume_logical(lines, index)
            packages = {
                name
                for name, _ in _requirements(" ".join(parts).split("install", 1)[1])
            }
            fallback = [part.strip() for part in parts]
            if "sshpass" in packages:
                output.extend(
                    [
                        'if [ "${BINY_FAST_VERIFIER:-0}" = 1 ]; then',
                        "  apt-get install -y sshpass",
                        "else",
                        *[f"  {part}" for part in fallback],
                        "fi",
                    ]
                )
            else:
                output.extend(
                    [
                        'if [ "${BINY_FAST_VERIFIER:-0}" = 1 ]; then',
                        "  # 快速路径不需要 curl 等安装器依赖",
                        "  :",
                        "else",
                        *[f"  {part}" for part in fallback],
                        "fi",
                    ]
                )
            continue

        if _UV_ENV_SCRIPT.match(line):
            output.extend(
                [
                    'if [ "${BINY_FAST_VERIFIER:-0}" != 1 ]; then',
                    f"  {stripped}",
                    "fi",
                ]
            )
            index += 1
            continue

        if eligible and _PIP_INSTALL.match(line):
            parts, index = _consume_logical(lines, index)
            output.extend(
                [
                    'if [ "${BINY_FAST_VERIFIER:-0}" = 1 ]; then',
                    "  # pytest 和 ctrf 已随预置工具链安装",
                    "else",
                    *[f"  {part.strip()}" for part in parts],
                    "fi",
                ]
            )
            continue

        if eligible and _UVX_START.match(line):
            parts, index = _consume_logical(lines, index)
            pytest_line = next(
                (item.strip() for item in parts if item.strip().startswith("pytest ")),
                None,
            )
            if pytest_line is not None:
                # 预置环境万一不可用（例如镜像 glibc 低于预置 Python 的基线），
                # 退回脚本原本的联网解析，而不是让判分命令直接消失。
                output.append('if [ "${BINY_FAST_VERIFIER:-0}" = 1 ]; then')
                output.append(f"  {_PYTEST_BIN} {pytest_line[len('pytest '):]}")
                output.append("else")
                for item in parts:
                    body = item.strip()
                    if body.startswith("uvx"):
                        body = f"UV_OFFLINE=false {body}"
                    output.append(f"  {body}")
                output.append("fi")
                continue
            output.extend(item.strip() for item in parts)
            continue

        output.append(line)
        index += 1

    path.write_text("\n".join(output) + "\n", encoding="utf-8")
