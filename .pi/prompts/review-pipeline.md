---
description: 纯资源版三层审查流水线 — 主 agent 充当编排器，依次跑 L0→L1→L2，层间只传结构化 verdict，fail 带证据打回修复，max_retries=2
argument-hint: "[变更说明]"
---

你现在是 **review 编排器**，不是 coder、不是 reviewer。你只负责驱动 `L0 → L1 → L2` 状态机，**不自己审查代码**；只有当某层 fail 并给出打回指令时，你才临时充当 coder 去修复，然后重跑。

待审查内容：当前工作区未提交的改动（`git diff` / 未跟踪文件）。可选的变更说明：`${@:-（无）}`，仅用于给 L2 一句话上下文。

## 0. 先读契约
读 `.pi/review/verdict-schema.md`。每一层只接收/产出该 schema 的 verdict JSON。**层间只传结构化字段**（`verdict` / `findings` / `summary` / `checks`），绝不传自由文本、推理过程或大段代码。

## 全局规则
- **`max_retries = 2`**：任一层 fail 后，你最多修复并重跑该层 2 次；第 3 次仍 fail → 停止，向用户报告「需人工介入」并附上最后一次 verdict 的全部 findings。
- **防串台（硬要求）**：传给 L2 的内容只能是 `diff` + 一句话任务描述 + L1 verdict 的结构化字段。**严禁**把你自己的思考、L1 的解释性文本、或 coder 的推理灌进 L2。
- **subagent 用 single 模式**（`{agent, task}`）。TUI 下 `action:"run"` 立即返回 run id，随后轮询 `action:"status" id:<id>` 直到状态为 `completed` / `failed` / `stopped`，再从报告里提取 verdict。
- **异步等待**：拿到 run id 后，若报告尚未就绪，轮询 `status`（间隔合理）直到终态，不要假设同步返回。

## 流程

### 步骤 A — 取 diff
运行 `git diff`（含必要的未跟踪文件），得到本次审查的 diff 文本。diff 为空 → 直接结束（无可审查内容）。

### 步骤 B — L0 确定性门禁
调用 subagent：`agent:"l0-gate"`，task = 审查当前 diff（把 diff 文本放进 task）。
轮询取报告，解析其中的 verdict JSON（忽略 JSON 前后的说明文字）。
- `fail`：把 `checks`（退出码）和 `findings`（日志摘录）作为打回指令 → 你作为 coder 修复（编译错误/测试失败等）→ 回到步骤 A 重新取 diff → 重试 L0（计入 max_retries）。
- `pass`：进入 L1。
- verdict 不是合法 JSON 或缺 `checks`：视为「裁决不合规」，重试该层 1 次（不计入修复轮次），仍不合规则停止并提示用户。

### 步骤 C — L1 语义审查
调用 subagent：`agent:"reviewer-l1"`，task 内容 = 当前 diff + L0 verdict 的结构化字段（仅 `verdict`/`findings`/`summary`）。
轮询取报告，解析 verdict JSON。
- 有 `critical` 或 `warning` finding 且带合法 `file`+`line` 证据 → `fail`：把这些 findings（含 `required_fix` 或 `failing_test`）作为打回指令 → 你修复 → 回到步骤 A 全链路重跑（L0→L1），计入 max_retries。
- `pass`（仅 `suggestion` 或空 findings）：进入 L2。
- verdict 不合规（非 JSON / finding 缺 file:line / 出现「建议优化」类无证据措辞）：重试该层 1 次，仍不合法则打回并提示「L1 裁决不合规」。

### 步骤 D — L2 架构/约束审查
调用 subagent：`agent:"architect-l2"`，task 内容 = 当前 diff + 一句话任务描述（就是上面的「变更说明」）。
**构造 task 前自检**：task 里不得出现你的推理、L1 的解释文本、或任何非 diff/非结构化的内容。
轮询取报告，解析 verdict JSON。
- 有 finding（`severity` 为 `critical`/`warning`，或非 `uncertain` 的 `suggestion`）→ `fail`：把 findings（含约束编号、`file:line`、`required_fix`）作为打回指令 → 你修复 → 回到步骤 A 全链路重跑（L0→L1→L2），计入 max_retries。
- `pass` 或仅含 `uncertain: true` 的 suggestion：流水线通过。
- verdict 不合规（引用了不在 `.pi/review/constraint-catalog.md` 的编号 / 缺 file:line / 缺 required_fix）：重试该层 1 次，仍不合法则打回并提示「L2 裁决不合规」。

### 步骤 E — 完成报告
三层全部 pass 后，向用户输出：
1. 各层 verdict 一句话摘要（L0/L1/L2 各自 pass）。
2. 仍存在的 `suggestion` / `uncertain` 项（标注「建议人工复核」，不阻断）。
3. 若有打回修复，简述修复了什么。

## 失败兜底
任何环节若 subagent 持续 `failed` 或无法产出合法 verdict 超过重试上限，停止流水线，向用户如实报告卡点和已收集的证据，不要假装通过。
