#!/usr/bin/env python3
"""检查 docs/architecture/overview.md 5.1 与 docs/architecture/threading.md 的硬约束是否被违反。

职责：把"文档里的约束"变成构建时能失败的检查。没有这个脚本，
DEP-01..05 与线程归属只是散文，实现时会被忘掉。

线程归属：无（构建/CI 脚本）。

用法：
    python tools/check_layers.py           # 检查，违规时退出码 1
    python tools/check_layers.py --list    # 只列当前扫描到的模块层次

检查项（编号与架构总览 5.1 对应）：
  DEP-01  include/ 不得包含 ../src 或指向 src 的路径
  DEP-02  src/platform/ 不得包含业务模块头文件
  DEP-03  同层模块不得互相 #include
  DEP-04  非 src/platform/ 的代码不得直接包含平台 SDK 头文件
  DEP-05  third_party/ 不得被修改（需 git 可用，缺失时跳过并警告）

以及 threading.md 第 1 节：
  THREAD-01  每个 .cpp 文件头必须有 `// Thread: <线程名>` 注释
  THREAD-02  该取值必须在白名单内

只做静态文本检查，不解析 C++ 语义。宁可漏报也不要乱报：
无法判定的情况输出 warning 而不是 failure。
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# 层次定义，与架构总览 5.1 的表一致
# ---------------------------------------------------------------------------

# 目录 -> 层次号（越小越靠下）。匹配使用路径前缀，最长前缀优先。
LAYERS: dict[str, int] = {
    "src/app/server": 6,
    "src/app/client": 6,
    "src/session": 5,
    "src/input": 5,
    "src/capture": 5,
    "src/codec": 5,
    "src/transport": 5,
    "src/telemetry": 5,
    "src/platform/win": 4,
    "src/platform/linux": 4,
    "src/platform/mac": 4,
    "include/remotedesktop": 3,
    "third_party": 2,
}

BUSINESS_MODULES = [
    "session", "input", "capture", "codec", "transport", "telemetry",
]

# DEP-04：业务代码不得直接接触的平台 API / SDK 头文件。
PLATFORM_TOKENS = [
    "SendInput", "BitBlt", "DXGI", "XTest", "XGetImage", "XShmGetImage",
    "windows.h", "X11/", "d3d11.h", "d3d12.h", "CoreGraphics/",
]

# THREAD-02 白名单，与 threading.md 第 1 节一致。
ALLOWED_THREADS = {
    "capture", "encode", "network", "session", "input",
    "decode", "ui", "writer", "any", "none",
}

THREAD_COMMENT = re.compile(r"^\s*//\s*Thread:\s*(.+?)\s*$", re.MULTILINE)

SOURCE_SUFFIXES = {".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"}


def layer_of(path: Path) -> int | None:
    """返回文件所属层次号，未归类返回 None。"""
    try:
        rel = path.relative_to(ROOT).as_posix()
    except ValueError:
        return None

    best_len = -1
    best_layer: int | None = None
    for prefix, layer in LAYERS.items():
        if rel == prefix or rel.startswith(prefix + "/"):
            if len(prefix) > best_len:
                best_len = len(prefix)
                best_layer = layer
    return best_layer


def module_of(path: Path) -> str | None:
    """返回 src/ 下的模块名（如 capture），用于同层比较。"""
    try:
        rel = path.relative_to(ROOT).as_posix()
    except ValueError:
        return None
    if not rel.startswith("src/"):
        return None
    if rel.startswith("src/platform/"):
        parts = rel.split("/")
        return "platform/" + parts[2] if len(parts) > 2 else "platform"
    parts = rel.split("/")
    if parts[1] == "app" and len(parts) > 2:
        return "app/" + parts[2]
    return parts[1]


def iter_sources() -> list[Path]:
    files: list[Path] = []
    for base in ("src", "include", "tests"):
        directory = ROOT / base
        if not directory.exists():
            continue
        for path in directory.rglob("*"):
            if path.is_file() and path.suffix in SOURCE_SUFFIXES:
                files.append(path)
    return sorted(files)


INCLUDE_PATTERN = re.compile(r'^\s*#\s*include\s*[<"]([^>"]+)[>"]', re.MULTILINE)


def includes_of(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return INCLUDE_PATTERN.findall(text)


def include_to_module(inc: str) -> str | None:
    """把 #include 目标映射到本项目模块名。非本项目返回 None。"""
    # 形如 "capture/frame_slot.h" 或 "../codec/encoder.h" 或 "remotedesktop/version.h"
    normalized = inc.replace("\\", "/")
    normalized = re.sub(r"^(\.\./)+", "", normalized)
    if normalized.startswith("remotedesktop/"):
        return "include"
    first = normalized.split("/")[0]
    if first in BUSINESS_MODULES or first in {"platform", "app"}:
        return first
    return None


def check_dep01(files: list[Path]) -> list[str]:
    """include/ 不得依赖 src/。"""
    problems: list[str] = []
    include_dir = ROOT / "include"
    if not include_dir.exists():
        return problems
    for path in include_dir.rglob("*"):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        for inc in includes_of(path):
            normalized = inc.replace("\\", "/")
            if "../src" in normalized or "/src/" in normalized:
                problems.append(
                    f"DEP-01 {path.relative_to(ROOT)}: 公共头包含 {inc!r}（指向 src/）"
                )
    return problems


def check_dep02(files: list[Path]) -> list[str]:
    """平台层不得依赖业务模块。"""
    problems: list[str] = []
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        if not rel.startswith("src/platform/"):
            continue
        for inc in includes_of(path):
            module = include_to_module(inc)
            if module in BUSINESS_MODULES:
                problems.append(
                    f"DEP-02 {rel}: 平台层包含业务头 {inc!r}"
                )
    return problems


def check_dep03(files: list[Path]) -> list[str]:
    """同层模块不得互引。"""
    problems: list[str] = []
    for path in files:
        owner = module_of(path)
        if owner is None:
            continue
        owner_layer = layer_of(path)
        if owner_layer is None:
            continue
        for inc in includes_of(path):
            target = include_to_module(inc)
            if target is None or target == owner or target == "include":
                continue
            # 只有能定位到具体目录时才比较层次
            candidate = ROOT / "src" / target
            if not candidate.exists():
                continue
            target_layer = LAYERS.get(f"src/{target}")
            if target_layer is None:
                continue
            if target_layer == owner_layer:
                problems.append(
                    f"DEP-03 {path.relative_to(ROOT)}: 同层互引 {inc!r}"
                    f"（{owner} 与 {target} 同为第 {owner_layer} 层）"
                )
    return problems


def check_dep04(files: list[Path]) -> list[str]:
    """业务代码不得直接使用平台 API。"""
    problems: list[str] = []
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        if rel.startswith("src/platform/") or rel.startswith("third_party/"):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for token in PLATFORM_TOKENS:
            if token in text:
                problems.append(
                    f"DEP-04 {rel}: 出现平台 API/头 {token!r}（应封装到 src/platform/）"
                )
    return problems


def check_dep05() -> list[str]:
    """third_party/ 不得被修改。"""
    third = ROOT / "third_party"
    if not third.exists():
        return []
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain", "--", "third_party"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        print("warning: 无法运行 git，DEP-05 跳过", file=sys.stderr)
        return []
    if result.returncode != 0:
        print("warning: git 返回非零，DEP-05 跳过", file=sys.stderr)
        return []
    dirty = [ln for ln in result.stdout.splitlines() if ln.strip()]
    return [f"DEP-05 third_party/ 被修改：{ln}" for ln in dirty]


def check_threads(files: list[Path]) -> list[str]:
    """每个源文件必须有 Thread 归属注释，取值在白名单内。"""
    problems: list[str] = []
    for path in files:
        if path.suffix not in {".cpp", ".cc", ".cxx"}:
            continue
        rel = path.relative_to(ROOT).as_posix()
        if rel.startswith("tests/"):
            continue
        try:
            head = path.read_text(encoding="utf-8", errors="replace")[:2000]
        except OSError:
            continue
        match = THREAD_COMMENT.search(head)
        if not match:
            problems.append(f"THREAD-01 {rel}: 缺少 `// Thread: <线程名>` 文件头注释")
            continue
        value = match.group(1).strip().lower()
        # 允许 "capture only" 这类带说明的写法，取第一个词
        first_word = re.split(r"[\s,;(（]", value)[0]
        if first_word not in ALLOWED_THREADS:
            problems.append(
                f"THREAD-02 {rel}: 线程名 {first_word!r} 不在白名单 "
                f"{sorted(ALLOWED_THREADS)}"
            )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="只列模块与层次")
    args = parser.parse_args()

    files = iter_sources()

    if args.list:
        seen: dict[str, int | None] = {}
        for path in files:
            module = module_of(path) or path.parent.relative_to(ROOT).as_posix()
            seen.setdefault(module, layer_of(path))
        for module in sorted(seen):
            print(f"  {module:30s} layer={seen[module]}")
        return 0

    problems: list[str] = []
    problems += check_dep01(files)
    problems += check_dep02(files)
    problems += check_dep03(files)
    problems += check_dep04(files)
    problems += check_dep05()
    problems += check_threads(files)

    if problems:
        for problem in problems:
            print(f"FAIL {problem}", file=sys.stderr)
        print(f"\n共 {len(problems)} 处违规", file=sys.stderr)
        print("依据：docs/architecture/overview.md 5.1、docs/architecture/threading.md 第 1 节", file=sys.stderr)
        return 1

    print(f"OK 分层与线程归属检查通过（{len(files)} 个源文件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
