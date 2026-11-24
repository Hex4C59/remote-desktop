#!/usr/bin/env python3
"""校验 docs/increments/ 中的增量文档、索引和审批状态。

Thread: none（构建与 CI 自检）。
用法：python tools/check_specs.py [--quiet]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

INCREMENTS_DIR = Path(__file__).resolve().parent.parent / "docs" / "increments"
ALLOWED_STATUS = {"draft", "approved", "implemented", "superseded"}
REQUIRED_SECTIONS = ["范围", "接口契约", "不变量", "线程与资源", "验收场景", "依赖与待决项"]
DOCUMENTS = ("spec.md", "plan.md", "tasks.md")
INCREMENT_NAME = re.compile(r"(?P<number>[0-9]{3})-[a-z0-9]+(?:-[a-z0-9]+)*")
STATUS_LINE = re.compile(r"status:\s*(\S+)\s*")
APPROVED_BY_LINE = re.compile(r"approved-by:\s*\S.*")
INDEX_ROW = re.compile(r"^\|\s*([0-9]{3})\s*\|\s*\[[^\]]+\]\(([^/)]+)/spec\.md\)\s*\|\s*`(\w+)`\s*\|")
NEXT_NUMBER = re.compile(r"^\*\*下一个可用编号 ([0-9]{3})\*\*$", re.MULTILINE)


def check_spec(label: str, text: str) -> tuple[str | None, list[str]]:
    problems: list[str] = []
    lines = text.splitlines()
    match = STATUS_LINE.fullmatch(lines[2]) if len(lines) > 2 else None
    status = match.group(1) if match else None
    if status not in ALLOWED_STATUS:
        problems.append(f"{label}: 第 3 行须声明有效的 status")
    elif status != "draft" and (len(lines) < 4 or not APPROVED_BY_LINE.fullmatch(lines[3])):
        problems.append(f"{label}: 状态为 {status} 时第 4 行须有 approved-by: <人, 日期>")

    for section in REQUIRED_SECTIONS:
        if not re.search(rf"^##+\s+.*{re.escape(section)}", text, re.MULTILINE):
            problems.append(f"{label}: 缺少必需章节“{section}”")

    _, heading, tail = text.partition("验收场景")
    if heading and not re.search(r"^\|\s*[A-Z][A-Z0-9]{0,5}-\d{2,4}\s*\|", tail, re.MULTILINE):
        problems.append(f"{label}: “验收场景”章节没有编号用例（如 | FH-01 |）")
    return status, problems


def check_index(root: Path, states: dict[str, str | None]) -> list[str]:
    index = root / "README.md"
    if not index.is_file():
        return ["docs/increments/README.md 不存在"]

    problems: list[str] = []
    text = index.read_text(encoding="utf-8")
    rows: dict[str, str] = {}
    numbers: set[int] = set()
    for line in text.splitlines():
        match = INDEX_ROW.match(line)
        if not match:
            continue
        number, directory, status = match.groups()
        name = INCREMENT_NAME.fullmatch(directory)
        if not name or name["number"] != number or int(number) == 0:
            problems.append(f"增量索引: 编号或目录名无效 {number} / {directory}")
        if int(number) in numbers:
            problems.append(f"增量索引: 重复编号 {number}")
        numbers.add(int(number))
        rows[directory] = status
        if directory not in states:
            problems.append(f"增量索引: {directory}/spec.md 不存在")

    for directory, status in states.items():
        if directory not in rows:
            problems.append(f"增量索引: 缺少 {directory}/spec.md 的登记")
        elif status in ALLOWED_STATUS and rows[directory] != status:
            problems.append(f"增量索引: {directory} 的状态应为 {status}")

    next_number = NEXT_NUMBER.search(text)
    expected = max(numbers, default=0) + 1
    if not next_number or int(next_number[1]) != expected:
        problems.append(f"增量索引: 下一个可用编号应为 {expected:03d}")
    return problems


def check_increments(root: Path) -> tuple[dict[str, str | None], list[str]]:
    problems: list[str] = []
    states: dict[str, str | None] = {}
    if not root.is_dir():
        return states, ["docs/increments/ 不存在"]

    for directory in sorted(path for path in root.iterdir() if path.is_dir()):
        name = directory.name
        if not INCREMENT_NAME.fullmatch(name) or name.startswith("000-"):
            problems.append(f"增量目录命名不合规: {name}")
        spec = directory / "spec.md"
        if not spec.is_file():
            problems.append(f"{name}: 缺少 spec.md")
            continue

        status, spec_problems = check_spec(f"{name}/spec.md", spec.read_text(encoding="utf-8"))
        problems.extend(spec_problems)
        states[name] = status
        has_plan = (directory / "plan.md").is_file()
        has_tasks = (directory / "tasks.md").is_file()
        if has_tasks and not has_plan:
            problems.append(f"{name}: 编写 tasks.md 前须有 plan.md")
        if status == "implemented" and not (has_plan and has_tasks):
            problems.append(f"{name}: implemented 规格须具备 plan.md 和 tasks.md")

    for filename in DOCUMENTS:
        for path in root.rglob(filename):
            relative = path.relative_to(root)
            if path.is_file() and len(relative.parts) != 2:
                problems.append(f"{relative.as_posix()}: 文档须直接放在编号增量目录中")

    if not states:
        problems.append("docs/increments/ 下没有规格")
    problems.extend(check_index(root, states))
    return states, problems


def main() -> int:
    states, problems = check_increments(INCREMENTS_DIR)
    if problems:
        for problem in problems:
            print(f"FAIL {problem}", file=sys.stderr)
        print(f"\n共 {len(problems)} 个问题", file=sys.stderr)
        return 1

    if "--quiet" not in sys.argv:
        print(f"OK 已校验 {len(states)} 个增量：")
        for directory, status in states.items():
            print(f"  {directory}: {status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
