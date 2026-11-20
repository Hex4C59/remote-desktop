# Pi 编排器工作流程

已有代码改动时，在 Pi 中运行 `/review`。新功能按讨论、规格、计划、任务、代码的顺序推进，阶段之间用 `/orch status` 确认下一步。项目的规格审批、TDD 和构建要求见 [AGENTS.md](AGENTS.md)。

## 启动

在仓库根目录打开 PowerShell。首次构建或清理过构建目录时，先运行 `cmake --preset debug`，确保 Git、Python、CMake、Ninja 和项目编译器可用。

```powershell
pi
```

进入 Pi 后输入 `/orch status`。Pi 从项目扩展目录加载命令。需要显式加载时，运行 `pi -e .pi/extensions/review.ts`。使用 `pi --review-auto` 启动时，Pi 会在 agent 一轮工作结束且有改动时询问是否审查。自动化调用使用 Pi 的 `--mode rpc`。 [Pi 扩展入口](.pi/extensions/review.ts)

## 审查已有改动

1. 用 `git status --short` 确认这轮审查的范围。`/review` 会采集暂存区、工作区和未跟踪文件中的改动，并排除编排器运行记录。
2. 在 Pi 输入 `/review`。L0 先构建并运行 CTest，L1 检查代码行为和测试。当前配置对中高风险改动加跑 L2 架构审查和 L3 人工决定。 [当前配置](.pi/orchestrator/config.json)
3. 根据打回报告中的证据修复问题。符合重试条件时，代码环会在 agent 修复后自动复审。停在人工决定时，先查看审查包再决定。
4. 审查通过后，由用户核对改动并决定何时提交。当前配置为 `autoCommit: false`。

## 交付新功能

每条命令运行一个阶段。按表从上往下执行，在需要人工批准的阶段等待用户决定。`DECISIONS.md`、`PLAN.md` 和 `TASK.md` 是示例路径，可以换成仓库内的实际文件路径。

| 阶段 | Pi 命令 | 交付物和退出条件 |
| --- | --- | --- |
| 讨论 | `/orch start discussion DECISIONS.md` | 记录目标、约束、已定取舍和待决问题，完成后进 `SPEC_DRAFT`。 |
| 规格 | `/orch start spec specs/spec-platform-win.md` | 规格写明接口契约、不变量、线程与资源、编号验收场景。L0 到 L2 通过后由用户在 L3 决定。 |
| 计划 | `/orch start plan PLAN.md` | 计划列出目标规格、任务、改动范围和验证命令。L0 验证验收用例覆盖，L1 检查计划，L3 由用户决定。 |
| 任务 | `/orch start task TASK.md` | 任务包含目标、验收依据、变更范围和验证方式。L0 和 L1 通过后进 `CODE_LOOP`。 |
| 代码 | 让主 agent 执行任务，然后输入 `/review` | 先复现失败测试，再实现、验证和审查。按风险决定是否需要 L2 和 L3。 |

`/orch start` 省略文件路径时，会调用只读 agent 起草并保存到 `.orchestrator/<run-id>/`。新规格整理到 `specs/spec-*.md`，在规格索引登记后，用实际文件路径送审。Spec 的 L0 检查仓库中的 `specs/` 和索引。 [规格状态和模板](specs/README.md)

L3 批准规格时，编排器记录决定并推进阶段。用户按仓库规则确认 `status: approved`、`approved-by:` 和索引状态后，Pi 才能依据该规格实现。当前配置为 `specStatusWrite: false`。 [规格审批规则](specs/README.md#审批状态)

### Plan 和 Task 怎么写

Plan 中直接写明目标规格的文件名，例如 `spec-platform-win.md`。列出每个任务的范围和验证命令，并把目标规格的每个验收编号映射到至少一个任务。未写可识别的规格名时，覆盖率检查会纳入仓库的全部规格。下面是覆盖率表的两行示例。 [计划模板](.pi/agents/planner.md)

| 验收编号 | 任务 |
| --- | --- |
| PW-01 | T1 |
| PW-02 | T1 |

Task 的四个小节可以直接用 `目标`、`验收依据`、`变更范围`、`验证方式`。例如由 `T1` 引用 `PW-01` 和 `PW-02`，列出允许改动的模块、预期的失败测试，以及对应的 `ctest --preset debug -R <用例名> --output-on-failure` 命令。 [任务模板](.pi/agents/task-writer.md)

## 批准、打回和恢复

| 当前情况 | 用户操作 |
| --- | --- |
| `SPEC_HUMAN`、`PLAN_HUMAN` 或 `AWAITING_HUMAN_REVIEW` | 查看审查包后，在弹窗中决定，或用 `/orch approve`、`/orch changes <具体修改要求>`、`/orch reject`。关闭弹窗会保留待批状态。 |
| 规格或计划被要求修改 | 改实际文档，再运行同一条 `/orch start <阶段> <路径>`。代码阶段按反馈修复并复审。 |
| `ESCALATED` | 用 `/orch status` 查看原因。处理异常后用 `/orch approve` 恢复原阶段，或用 `/orch reject` 终止。恢复原阶段后继续完成该阶段的检查。 |
| Pi 重启或切换会话 | 用 `/orch resume <run-id>` 恢复指定运行。省略 ID 时选最近的运行，之后用 `/orch status` 确认状态。 |
| 主动结束或导出 | `/orch abort` 终止运行并留存证据。`/orch export` 导出当前审查包到 `test-results/orchestrator-export/`。 |

`/orch status` 会显示运行 ID、阶段、检查点和下一步。审查包位于 `.orchestrator/<run-id>/checkpoints/<checkpoint>/review-package/`，先读 `summary.md`，再按需查 `diff.patch`、L0 日志、L1 发现、L2 裁决和 `evidence.sha256`。显式 `/orch approve` 会核对待批包的哈希。待批期间若改了文档或代码，重新送审并查看新包后再批准。 [证据目录说明](.pi/orchestrator/README.md#6-目录契约证据链)

L2 当前要求来自至少两个不同模型家族的有效票，并会排除主 agent 所属家族。若面板票数不足，先看成员是认证失败、不可用还是超时，处理后恢复审查。 [面板配置](.pi/orchestrator/config.json)

## Pi 执行约定

- 开始任务前读取 [AGENTS.md](AGENTS.md) 和相关规格。已有批准规格时使用对应验收编号。新功能或会改变契约的改动先处理规格审批，回归修复按仓库的 SDD/TDD 路由执行。
- 使用 `/orch status` 确认本轮阶段，按顺序推进。当前命令支持直接进入指定阶段，强制校验前序审批仍在草案中。 [阶段门禁草案](specs/spec-review-orchestrator-gates.md)
- 到达 L3 时，把运行 ID、检查点、审查包路径和待决定事项交给用户，等待用户作决定。Pi 可以按反馈修复和复审，规格状态与 L3 决定由用户确认。
- 实现时记录验收编号和红灯原因，随后运行目标测试以及完整的 `ctest --preset debug --output-on-failure`。交付时给出实际结果与证据路径。测试日志可按用途保存在 `test-results/build/` 或 `test-results/orchestrator/`。
