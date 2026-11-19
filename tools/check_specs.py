#!/usr/bin/env python3
"""校验 specs/ 下每份规格的状态行与必需章节。

职责：把 specs/README.md 的约定变成可执行检查，避免"写了规范但没人遵守"。
线程归属：无（构建/CI 脚本，不参与运行时）。

用法：
    python tools/check_specs.py            # 检查，失败时退出码 1
    python tools/check_specs.py --quiet    # 只在失败时输出

检查项：
  1. specs/spec-*.md 第 3 行必须是 `status: <状态>`，状态在允许集合内。
  2. 除 draft 外，下一行必须有 `approved-by:`。
  3. 必需章节存在：范围、接口契约、不变量、线程与资源、验收场景、依赖与待决项。
  4. 验收场景章节必须含至少一行表格数据（形如 `| XX-01 |`）。
  5. specs/README.md 的"现有规格"表与实际文件一致。

不检查内容质量，只检查结构和状态的一致性——质量由评审负责。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SPECS_DIR = Path(__file__).resolve().parent.parent / "specs"

ALLOWED_STATUS = {"draft", "approved", "implemented", "superseded"}

REQUIRED_SECTIONS = [
    "范围",
    "接口契约",
    "不变量",
    "线程与资源",
    "验收场景",
    "依赖与待决项",
]

STATUS_LINE = re.compile(r"^status:\s*(\S+)\s*$")
APPROVED_BY_LINE = re.compile(r"^approved-by:\s*(\S.*)$")


def check_spec(path: Path) -> list[str]:
    problems: list[str] = []
    lines = path.read_text(encoding="utf-8").splitlines()

    if len(lines) < 3:
        return [f"{path.name}: 文件过短，缺少标题与状态行"]

    status_line = lines[2]
    match = STATUS_LINE.match(status_line)
    if not match:
        problems.append(
            f"{path.name}: 第 3 行必须是 'status: <状态>'，实际是 {status_line!r}"
        )
        status = None
    else:
        status = match.group(1)
        if status not in ALLOWED_STATUS:
            problems.append(
                f"{path.name}: 未知状态 {status!r}，允许 {sorted(ALLOWED_STATUS)}"
            )

    if status and status != "draft":
        following = lines[3] if len(lines) > 3 else ""
        if not APPROVED_BY_LINE.match(following):
            problems.append(
                f"{path.name}: 状态为 {status} 时第 4 行必须有 'approved-by: <人, 日期>'"
            )

    text = "\n".join(lines)
    for section in REQUIRED_SECTIONS:
        if not re.search(rf"^##+\s+.*{re.escape(section)}", text, re.MULTILINE):
            problems.append(f"{path.name}: 缺少必需章节“{section}”")

    # 验收场景必须至少有一条编号用例，防止写成空标题。
    if "验收场景" in text:
        tail = text.split("验收场景", 1)[1]
        if not re.search(r"^\|\s*[A-Z][A-Z0-9]{0,5}-\d{2,4}\s*\|", tail, re.MULTILINE):
            problems.append(
                f"{path.name}: “验收场景”章节没有编号用例（应形如 | FH-01 | ... |）"
            )

    return problems


def check_index(spec_files: list[Path]) -> list[str]:
    """specs/README.md 的现有规格表应列出全部 spec-*.md，且状态与实际一致。"""
    problems: list[str] = []
    index = SPECS_DIR / "README.md"
    if not index.exists():
        return ["specs/README.md 不存在"]

    text = index.read_text(encoding="utf-8")
    for spec in spec_files:
        if spec.name not in text:
            problems.append(f"specs/README.md: 未列出 {spec.name}")
            continue

        # 索引里的状态必须与文件第 3 行一致，防止改了状态忘了改索引。
        lines = spec.read_text(encoding="utf-8").splitlines()
        match = STATUS_LINE.match(lines[2]) if len(lines) > 2 else None
        if not match:
            continue
        actual = match.group(1)

        # 只匹配“现有规格”表里的行：以 `| [文件名](文件名)` 开头，
        # 避免命中文档上面的命名示例。
        row = next(
            (ln for ln in text.splitlines()
             if ln.startswith(f"| [{spec.name}]({spec.name})")),
            None,
        )
        if row is None:
            problems.append(
                f"specs/README.md: “现有规格”表没有 {spec.name} 的行"
            )
        elif f"`{actual}`" not in row:
            problems.append(
                f"specs/README.md: {spec.name} 的索引状态与文件不一致"
                f"（文件为 {actual}）"
            )

    return problems


def main() -> int:
    quiet = "--quiet" in sys.argv
    spec_files = sorted(SPECS_DIR.glob("spec-*.md"))
    if not spec_files:
        print("错误：specs/ 下没有任何 spec-*.md", file=sys.stderr)
        return 1

    problems: list[str] = []
    for spec in spec_files:
        problems.extend(check_spec(spec))
    problems.extend(check_index(spec_files))

    if problems:
        for problem in problems:
            print(f"FAIL {problem}", file=sys.stderr)
        print(f"\n共 {len(problems)} 个问题", file=sys.stderr)
        return 1

    if not quiet:
        print(f"OK 已校验 {len(spec_files)} 份规格：")
        for spec in spec_files:
            status = STATUS_LINE.match(spec.read_text(encoding='utf-8').splitlines()[2])
            print(f"  {spec.name}: {status.group(1) if status else '?'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
