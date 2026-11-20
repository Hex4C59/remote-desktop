# 结构化裁决契约（Verdict Schema）

> 这是 L0 / L1 / L2 三层与编排器之间**唯一允许传递**的信息格式。
> 层间不得传递自由文本、推理过程或代码片段，只传递本契约定义的裁决 JSON。
> 编排器必须校验每一层输出是否为合法 JSON 且含必填证据字段；不合规视为该层 fail。

## 1. 顶层结构

每层（L0 / L1 / L2）必须输出一个独立的 verdict 对象。允许多个 finding，但 `verdict` 只有一个。

```jsonc
{
  // 必填：产生裁决的层
  "layer": "L0",          // "L0" | "L1" | "L2"

  // 必填：整体结论
  "verdict": "pass",      // "pass" | "fail"

  // 必填：所有发现。pass 时可以为空数组，但不得省略该字段。
  "findings": [
    {
      // 必填：严重程度。L0 不使用此字段（见下）。
      "severity": "critical",  // "critical" | "warning" | "suggestion"

      // 必填：定位到文件。L0 可为 "build" / "test" / "lint" 等检查类别而非具体文件。
      "file": "src/capture/win_capture.cpp",

      // 选填：行号（1-based）。L0 无行号时省略。
      "line": 142,

      // 必填：证据。各层证据标准不同，见第 2 节。
      "evidence": "第 142 行在 capture 线程内调用了 encoder.Encode()，违反 THREAD-01",

      // 必填（二选一）：让 coder 可执行的修复指令，或一个失败测试/复现步骤。
      "required_fix": "将 Encode() 调用移出 capture 线程，改为投递到编码队列",
      // 或
      "failing_test": "在 tests/unit/capture/test_capture_thread.cpp 中新增用例，断言 capture 线程不阻塞在 encoder 上"
    }
  ],

  // 必填：一句话总结。编排器会把它和 findings 一起呈现给 coder。
  "summary": "通过 L0 门禁；编译与测试（含 arch.layers、spec.structure）均通过。",

  // 选填：该层执行的确定性检查清单（仅 L0 用），便于审计。
  "checks": [
    { "name": "cmake_build", "exit_code": 0, "log_excerpt": "Build succeeded" },
    { "name": "ctest_arch.layers", "exit_code": 0, "log_excerpt": "1/1 passed" },
    { "name": "ctest_spec.structure", "exit_code": 0, "log_excerpt": "1/1 passed" }
  ]
}
```

### 1.1 verdict 判定规则
- **L0**：任一检查 exit_code != 0 → `verdict: "fail"`，并把失败检查作为 finding（`file` 为检查类别名，`evidence` 为日志摘录）。全部通过 → `"pass"`。
- **L1**：存在任一 `severity: "critical"` 或 `"warning"` 的 finding → `fail`；只有 `"suggestion"` 或空 → `pass`（suggestion 不阻断，仅提示）。
- **L2**：存在任一 finding（任何 severity）→ `fail`。架构越界必须严肃处理，不分级放行；若不确定是否越界，在 `summary` 写"需人工复核"并仍按 `pass` 处理（宁可漏报，不可误阻断），同时该 finding 的 `severity` 标 `"suggestion"` 并附"uncertain"标记。

## 2. 各层证据标准（必填，缺则判违规）

### L0 确定性门禁 — 证据 = 退出码 + 日志摘录
- `findings[].evidence` **必须**来自命令实际输出，不得是 LLM 推断。
- `findings[].file` 为检查类别：`build` / `ctest` / `lint` / `format` / `security`，或具体测试名如 `ctest:arch.layers`。
- `findings[].evidence` 摘录失败日志的关键行（编译错误、失败断言、退出码）。
- L0 **不允许**出现 `severity`、`line`、`required_fix`、`failing_test` 的主观内容——L0 只报事实，修复方向留给 L1/coder。
- `checks` 字段必填，列出每个检查的 `name` / `exit_code` / `log_excerpt`。

### L1 语义审查 — 证据 = file:line + 复现/失败测试
- 每个 finding **必须**有 `file` 和 `line`（1-based）；定位不到行的 issue 不得列为 finding。
- `evidence` 必须说明**触发条件/复现路径**，而非泛泛而谈（如"代码质量一般"是违规的）。
- `required_fix` 与 `failing_test` 二选一必填：
  - 能写出具体改法的，给 `required_fix`；
  - 行为性 bug，给 `failing_test`（一个可复现的测试场景或断言）。
- 禁止："建议优化"、"可以考虑"、"感觉有问题"这类无证据措辞——出现即判该 finding 无效，整层 verdict 降为 fail（"裁决不合规"）。

### L2 架构/约束审查 — 证据 = 违反的约束条目编号 + 定位
- 每个 finding 的 `evidence` **必须引用具体约束编号**，如 `DEP-03`、`THREAD-01`、`LATENCY-6.2`、`PLATFORM-ABSTRACTION-6.3`，或 `spec-<name>:<验收用例编号>`。
- `file` + `line` 指向违反约束的代码位置（允许 L2 读最小代码上下文定位）。
- `required_fix` 必须说明如何让代码回到约束边界内（如"该调用应移至 encode 线程"）。
- L2 **不得**在 evidence 中复述 coder 的实现推理或大段代码；只引用约束编号 + 最小定位。
- 若无法确定是否越界，在该 finding 上加 `"uncertain": true`，`severity` 为 `"suggestion"`，并在 `summary` 标注"需人工复核"，不阻断通过。

## 3. 编排器校验规则

编排器收到每层输出后执行以下校验，任一失败 → 该层 verdict 视为 **fail**（标记 `"verdict_invalid": true`），重试一次；重试仍不合法 → 打回 coder，提示"裁决不合规：<原因>"。

1. 输出必须是**单个合法 JSON 对象**（忽略 JSON 前后的说明性文本，但 JSON 本体必须可独立解析）。
2. 顶层 `layer` ∈ {L0, L1, L2}，且与调用的层一致。
3. 顶层 `verdict` ∈ {pass, fail}。
4. `findings` 必须是数组。
5. 每个 finding：
   - L1/L2 finding 必须含非空 `file`、非空 `evidence`、（`required_fix` 或 `failing_test` 至少一个非空）。
   - L1 finding 必须含 `line`（正整数）。
   - L2 finding 的 `evidence` 必须匹配约束编号正则（`[A-Z]+-\d+` 或 `spec-\S+:\S+`），否则判不合规。
   - `severity` ∈ {critical, warning, suggestion}（L0 忽略）。
6. `summary` 必须是非空字符串。
7. L0 必须有非空 `checks` 数组，每项含 `name` 和 `exit_code`。

校验通过后，编排器从 verdict 中**只提取** `verdict`、`findings`、`summary` 传给下一层或打回给 coder，**剥离**任何其他文本（含 LLM 的解释、思考、代码片段）。

## 4. 不串台保证

- 传给 L1 的输入 = coder 的 diff + L0 verdict（仅结构化字段）。
- 传给 L2 的输入 = coder 的 diff + **约束清单**（specs/docs 的条目编号列表，不含 coder 推理）+ L1 verdict（仅结构化字段）。
- L1 的完整输出文本（含其解释）**不进入** L2 task，只传解析后的 verdict JSON。
- coder 收到的打回 = 该层 verdict 的结构化 findings + summary，不附 reviewer 的推理过程。
