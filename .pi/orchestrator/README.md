# 四层审查 + 五阶段交付流水线（review-orchestrator）

把「确定性编排器 + 分层审查」落到 remote-desktop 项目：

**L0 硬地板 → L1 独立语义 → L2 跨 vendor 面板 → L3 人类批准**，覆盖
**讨论 → Spec → Plan → Task → Code** 五个阶段。编排器只调度、不写码、不审码；
人只在 L3 入口和异常出口出现。

设计来源：`/review` 的目标是让审查不能退化成「第二个 agent 点头」，因此各层职责分离、
证据标准不同、上下文互不可见；「下一步做什么」由显式状态机决定，不由模型决定。

## 1. 触发方式

| 方式 | 说明 |
|---|---|
| `/review` | Code 环：L0（build+ctest）→ L1 → 风险触发 L2 面板 → L3 |
| `/orch start [discussion\|spec\|plan\|task] [路径]` | 运行一个交付阶段；不传路径则由只读生产 agent 起草 |
| `/orch resume [run-id]` | 从 `.orchestrator/<run-id>/state.json` 恢复上一次中断的运行 |
| `/orch status` | 显示状态机、阶段、checkpoint、审查包 hash、升级记录与下一步 |
| `/orch approve \| changes <说明> \| reject` | L3 决定；决定绑定审查包 sha256 |
| `/orch abort` | 从任意非终态终止本次运行（证据链保留） |
| `/orch export` | 把审查包导出到可提交目录 |
| 工具 `review_l0_gate` | 只跑 L0（零 LLM） |
| `--review-auto` | agent 结束且工作区有改动时询问是否跑 `/review` |
| `--review-legacy` | 使用旧的三层 `/review` 行为（向后兼容） |
| `/review-pipeline` | 纯资源版回退，不依赖扩展 |

## 2. 蓝图映射

| 蓝图要求 | 本实现 |
|---|---|
| L0 确定性门禁，红了不进 L1 | `l0.ts` / `l0-stages.ts`；各阶段独立门禁，退出码说话 |
| L1 独立只读语义审查 | 每层独立 `pi --no-session` 子进程，`--tools read,grep,find,ls` |
| L2 跨 vendor 面板，脚本聚合 | `panel.ts` / `panel-runner.ts` / `aggregate.ts`；按**模型家族**排除 coder vendor |
| L3 人类批准 + 结构化审查包 | `package.ts` / `human.ts`；模板化 summary + 证据 sha256 + 决定记录 |
| 五阶段状态机 | `machine.ts` 显式转移表；`stage-pipeline.ts` 阶段接线 |
| 确定性风险分级 | `risk.ts` 纯函数；`pipeline.ts` 按 low/medium/high 路由 |
| 落盘证据链 | `store.ts`：`.orchestrator/<run-id>/…`，原子写 + 可独立复算 |
| 异常升级器 | `escalate.ts`：8 类确定性触发 → `escalations/*.json` |
| 编排器不写码不审码 | 生产与审查都在独立子进程；编排器只拼结构化输入、校验裁决、路由 |

## 3. 四层职责与证据标准

| 层 | 执行方式 | 证据标准 | 阻断条件 |
|---|---|---|---|
| **L0** | 脚本/工具链（build、ctest、`tools/check_specs.py`、覆盖率矩阵、TASK 结构） | 退出码 + 日志摘录 | 任一检查退出码非 0 / 覆盖率缺失 / 结构缺失 |
| **L1** | 独立只读子进程（`reviewer-l1`） | 必须 `file:line` + 触发条件 + `required_fix` 或 `failing_test` | 存在 `critical`/`warning` finding |
| **L2** | 每成员独立只读子进程（`architect-l2`），跨家族面板 | 必须引用约束编号（`HANDOFF-1`、`PLAT-3`…）或 `spec-<stem>:<case>` | 任一 FAIL；有效票不足法定人数或裁决互斥 → BLOCKED（升级，不静默放行） |
| **L3** | TUI/RPC 交互；print/json 模式写包停等命令 | 人 + 时间戳 + 包 sha256 | 无决定不前进；包变化则旧批准失效 |

L0 复用项目已有的确定性检查：`ctest` 里的 `arch.layers`（DEP-01..05、THREAD-01/02）
与 `spec.structure`。**L1/L2 不重复报告这些**——静态扫描已覆盖的部分不消耗 LLM。

## 4. 状态机（确定性，可恢复）

```
DISCUSSION → SPEC_DRAFT → SPEC_L0 → SPEC_L1 → SPEC_L2 → SPEC_HUMAN
           → PLAN_DRAFT → PLAN_L0 → PLAN_L1 → PLAN_HUMAN
           → TASK_LOOP → CODE_LOOP → AWAITING_HUMAN_REVIEW → COMMITTED
           → DONE / ABORTED / ESCALATED
```

关键不变量（`machine.ts` 强制，单测逐条覆盖）：

- 未经过 `human-approve`，阶段绝不前进；取消/关闭对话框不算批准。
- L0 红只回生产侧，绝不向前。
- `ESCALATED` 只能由人工裁决离开；`DONE` / `ABORTED` 是终态。
- 非法 `(state,event)` 被拒绝且不修改快照，不静默忽略。
- `state.json` 损坏时报告错误，不重置成 `DISCUSSION`（否则会重跑人已批准的门禁）。
- 升级/终止保留原 `stage`，人工恢复时回到真正出问题的阶段。

## 5. 配置（`.pi/orchestrator/config.json`）

所有路由/分级/门禁决策来自配置，不由 LLM 自由判断；缺字段或非法值 **fail-closed**。

| 配置 | 默认 | 说明 |
|---|---|---|
| `panel.members` | deepseek / qwen / openai 三家族 | `family` 是模型家族，不是 provider id |
| `panel.quorum` | 2 | 有效票不足 → BLOCKED，不静默放行 |
| `panel.minDistinctFamilies` | 2 | 同家族多票不算独立审查 |
| `panel.concurrency` | 2 | 1..3 |
| `panel.timeoutMs` | 480000 | 单成员超时 |
| `risk.forbiddenPaths` | `third_party/`、`.git/`、`build/` | 命中必升级，不得自动放行；不可为空 |
| `risk.highPaths` / `mediumPaths` | 平台/传输/会话/输入等 | 路径分级 |
| `risk.mediumLines` / `highLines` | 50 / 300 | 改动行数阈值 |
| `limits.maxRetries` | 2 | 打回上限 |
| `limits.maxL0ConsecutiveFailures` | 2 | L0 连续红升级阈值 |
| `autoCommit` | `false` | 默认不写用户仓库；开启才允许低风险自动提交 |
| `specStatusWrite` | `false` | 默认**不**自动把 spec 改成 approved（AGENTS.md 硬规则） |
| `artifacts.root` | `.orchestrator` | 默认加入 `.gitignore` |
| `stages.*` | 见配置文件 | 每阶段 L0/L1/面板/人工门禁开关；`human:"risk"` 只允许 `code`，discussion/task 不接受人工门禁（无对应状态） |

## 6. 目录契约（证据链）

```
.orchestrator/<run-id>/
  state.json                 状态机、checkpoint、重试计数、包 hash、人工决定
  DECISIONS.md               讨论结论：选 A 不选 B 的理由
  spec/{spec.md,l0-results.json,l1-findings.json,l2-verdict.json,l2-panel.json}
  plan/{plan.md,coverage-matrix.json,l0-results.json,l1-findings.json}
  task/{TASK.md,l0-results.json,l1-findings.json}
  checkpoints/<cp>/{TASK.md,diff.patch,l0-results.json,l1-findings.json,
                   l2-verdict.json,l2-panel.json,human-decision.json,
                   review-package/{summary.md,risk-assessment.md,diff.patch,
                                   evidence.sha256,artifacts-index.md}}
  escalations/<timestamp>-<reason>.json
```

保证：

- 原子写（临时文件 + rename），崩溃不会留下半个 verdict。
- `evidence.sha256` 可用 `sha256sum -c evidence.sha256` 在包目录内独立复算。
- 写入前拒绝疑似密钥/Token；包内不含凭据。
- `/orch export` 把包复制到 `test-results/orchestrator-export/<run>/<cp>/`。

## 7. 关键约束如何被强制执行

| 目标 | 实现方式 | 为什么可靠 |
|---|---|---|
| 层间不串台 | L2 task 只含 diff + 约束清单 + **L1 结构化 verdict** | L1 散文/推理没有进入构造路径；单测断言标记字符串不外泄 |
| reviewer 不看 coder 推理 | `--no-session` 全新上下文 | 不是靠 prompt 约束 |
| L1/L2 只读 | `--tools read,grep,find,ls` | 写工具在子进程里不存在 |
| 裁决必须合规 | `verdict.ts` 按 schema 校验；不合规重试 1 次后判 `invalid` | 缺 `file:line`、L2 缺约束编号、空泛措辞都会被拒 |
| L3 不能绕过 | 决定绑定包 hash；状态机只在 human gate 接受决定 | 重复 approve 无法跳过阶段；包变化使旧批准失效 |
| spec 状态不被擅改 | `specStatusWrite=false` 时只落盘决定 + 给出待改行 | 符合 `specs/README.md` 与 AGENTS.md |
| 风险不靠模型 | `risk.ts` 纯函数 + 禁止路径必升级 | 可审计、表驱动单测 |
| 循环有界 | `maxRetries`、`maxL0ConsecutiveFailures`、diff 未变即停 | 三个刹车 |
| 面板排除 coder vendor | 按模型家族推断，不按 provider id | `opencode-go` 等网关不会误杀整个面板 |

## 8. 与批准计划的两处偏差（有依据）

1. **语言用 TypeScript，不是 Python/shell。** Pi 扩展是唯一能拿到 `pi.exec`、`ctx.ui`
   与会话事件的宿主；改 Python 会丢掉 Pi 集成并废弃已验证资产。蓝图的实质要求是
   **确定性**，由纯函数 + 显式转移表 + 落盘 `state.json` 满足。
2. **排除 coder vendor 按「模型家族」，不按 provider id。** 网关同时托管多个家族；
   按 provider 排除会在 coder 使用网关时误杀整个面板。

另有一处实现方式偏差：L1/L2 直接 spawn 同步 `pi -p --mode json --no-session` 子进程，
而不是调用 `subagent` 工具。原因：`ExtensionCommandContext` 没有 `executeTool()`；
subagent 在 TUI 下是异步后台，命令内拿不到裁决，无法驱动重试。直接 spawn 反而更强
（机械只读、机械隔离、同步校验）。

## 9. 文件

```
.pi/review/verdict-schema.md        裁决契约（层间唯一允许格式）
.pi/review/constraint-catalog.md    L2 可引用的权威约束编号
.pi/review/interface-notes.md       subagent 扩展接口核实记录
.pi/review/verification-results.md  逐条验证记录（含发现的真实缺陷与修法）
.pi/agents/{discussion,spec-writer,planner,task-writer}.md  生产侧 profile（只读）
.pi/agents/{reviewer-l1,architect-l2}.md                    审查侧 profile（只读）
.pi/extensions/review.ts           Pi 自动发现的入口
.pi/orchestrator/
  config.json                       审查与交付配置
  src/extension.ts                  注册命令、工具和生命周期回调
  src/workflow/                     配置、状态机、阶段编排和异常升级
  src/review/                       子进程、面板、裁决和风险分级
  src/checks/                       L0 门禁和计划覆盖率
  src/evidence/                     证据、审查包、人工决定和提交守卫
  tests/{workflow,review,checks,evidence}/   按模块分组的单元测试
  tests/integration/                命令、全链路和运行环境验证
```

## 10. 运行测试

```bash
# 编排层单测（需要 Node.js 和 Git）
node --experimental-strip-types --test ".pi/orchestrator/tests/**/*.test.ts"

# C9：/orch 命令接线（需要能解析 Pi SDK；见下）
node --experimental-strip-types .pi/orchestrator/tests/integration/verify-commands.ts

# C11：全流水线（假子进程，不需要模型）
node --experimental-strip-types .pi/orchestrator/tests/integration/verify-fullpipeline.ts

# 真实工具链 + 故障注入
node --experimental-strip-types .pi/orchestrator/tests/integration/verify-e2e.ts
node --experimental-strip-types .pi/orchestrator/tests/integration/verify-safety.ts
PI_REVIEW_PI_BIN=<path-to-pi-or-cli.js> \
  node --experimental-strip-types .pi/orchestrator/tests/integration/verify-fullchain.ts

# 项目本身回归（必须全过）
ctest --preset debug --output-on-failure
```

`verify-commands.ts` 需要解析 `@earendil-works/pi-coding-agent` 与 `typebox`。可将
`.pi/orchestrator/` 和 `.pi/extensions/review.ts` 按原路径复制到装有这些包的临时目录，
设置 `ORCH_REPO=<仓库根>` 后，从临时目录运行上述命令。该脚本读取仓库配置和 agent 定义，
在独立的临时目录中验证命令。

`verify-safety.ts` 在临时目录运行真实 Pi，验证只读工具能否阻止写文件，以及运行中和启动前的取消行为。
父进程逐行解析审查进程的 JSONL，标准输出和错误输出各保留最后 64 KiB 用于诊断。
单条 JSONL 记录超过 2 MiB 时终止该次审查并报告失败，避免使用先前的裁决。
Windows 通过系统自带的 PowerShell 启动审查进程，并用 Job Object 管理后代进程。
正常退出、取消或超时都会清理这个审查进程树，包含独立启动的后代。
Windows 上独立运行时自动定位 Pi 官方安装的 CLI。自定义安装可通过
`PI_REVIEW_PI_BIN` 指定 JavaScript CLI 入口或原生可执行文件的绝对路径。

## 11. 已验证结果

| 验证 | 结果 |
|---|---|
| 22 套单测（A/B/C 段） | 433 项全绿 |
| `commands.test.ts`（C9 决定/resume 纯逻辑） | 12/12 |
| `verify-commands.ts`（真实 `/orch` 处理器） | 13/13 |
| `verify-fullpipeline.ts`（C11 全流水线） | 13/13 |
| 四层真验证（`verify-four-layer.ts`，真模型 + 真工具链） | 22/22 |
| 全链路（`verify-fullchain.ts`，三轮修复） | 13/13 |
| Pi RPC 真实命令（`/orch start spec` + L3 approve） | L0 → L2 面板 PASS 2/2 → L3 → PLAN_DRAFT；详见 `verification-results.md` |
| 安全（只读/abort） | 3/3 |
| `ctest --preset debug` | 10/10（含 `arch.layers`、`spec.structure`） |

## 12. 已知限制

- **coder 未隔离**：主 agent 既是 coder 又是编排器，存在自我一致性风险。若日后发现
  自我说服严重，可把 coder 也子进程化，但会改变交互方式。
- **`/orch` 只在 TUI/RPC 下可用**：`pi -p --mode json "/orch …"` 不会执行扩展命令（print 模式只输出 session 事件）。真实无头的替代路径是 `--mode rpc`，通过 `prompt` + `extension_ui_response` 完成 L3 决定；无人决定时状态机绝不前进。
- **面板成本随成员数线性增长**：每成员一个完整子进程；已用 `thinking: low` 降本。
- **L2 只做粗筛**：只给 diff + 约束清单；需要跨文件运行时推理的越界可能漏报，
  `uncertain` 项标为「需人工复核」而不阻断。
- **裁决由模型生成**：schema 校验能挡住格式违规与无证据项，挡不住「证据看似具体
  实则错误」；重要结论仍需人核验。真实 RPC 运行中 L1 曾把合法的 `// Thread: any`
  误报为违反 THREAD-02（`docs/threading.md:33` 明确允许），这正是 L3 存在的理由。
- **子进程继承父进程权限**：不是沙箱，只是工具集受限 + 独立上下文。
- **`/orch start` 的重试是显式的**：交付物被打回后需修改文档并再次
  `/orch start <stage> [路径]`；不会自动让主 agent 改规格/计划。Code 环仍保留自动重跑。
- **Spec L0 校验的是仓库里的 `specs/`**：`tools/check_specs.py` 按项目索引检查整组规格；
  只存在于 `.orchestrator/…/spec/spec.md` 的草稿不会自动入库，需人把草稿落到 `specs/`
  后再跑一次（这也是 `specs/README.md` 要求人批准状态的原因）。
- **`autoCommit` 默认关闭**：低风险也保留在工作区待人工提交；开启后仍受风险分级与
  提交守卫限制。

## 13. 回退

1. 禁用扩展：从 `.pi/extensions/` 移走 `review.ts`，或 `pi -ne` 启动；
   `/reload` 生效。
2. 用 `--review-legacy` 保留旧三层 `/review`。
3. 改用纯资源版：`/review-pipeline <任务说明>`，由主 agent 手动驱动三层。
4. 完全不用编排层：`ctest --preset debug` + 人工 review，项目原有约束不受影响
   （`arch.layers` / `spec.structure` 一直生效）。
