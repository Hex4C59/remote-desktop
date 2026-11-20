# 验证结果记录（计划步骤 11）

本文件记录每条验证项的**实际执行方式与结果**。未跑通的项明确标注，不算通过。

最后更新：实现完成后的端到端验证。

## 逐条结果

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 接口核实 / agent 发现 | ✅ 通过 | probe 返回 `Available agents: architect-l2, l0-gate, reviewer, reviewer-l1, scout, worker`；注册探针确认工具 `review_l0_gate`、命令 `/review`、模板 `/review-pipeline` 均被发现 |
| 2 | 纯资源版流程连通 | ✅ 通过 | L1 run `#75d3796304434ea0`、L2 run `#31d478c0e26d4a56` 均完成并产出合法 verdict JSON（脚本按 schema §3 校验通过）；L1 发现真实问题（`kNoNewFrame` 契约矛盾） |
| 3 | L0 确定性阻断 | ✅ 通过 | `verify-e2e.ts` 7/7：注入真实编译错误 → `outcome=blocked, blockingLayer=L0`，**子进程调用次数 = 0**，构建日志进入打回文本；ctest 日志含 `arch.layers` 与 `spec.structure` |
| 4 | L1 证据强制 | ✅ 通过 | `verdict.test.ts` + `orchestrator.test.ts`：非 JSON / 缺 `file:line` / 缺 `required_fix` → 重试 1 次后判 `invalid`；`c.calls.L1 === 2` 断言重试恰好一次 |
| 5 | L2 隔离 | ✅ 通过 | 子进程 `--no-session` 全新上下文 + task 仅由 diff/约束清单/结构化 verdict 构造；`orchestrator.test.ts` 断言 L2 task 含约束清单与 L1 结构化字段 |
| 6 | 层间不串台 | ✅ 通过 | `orchestrator.test.ts` 用标记串 `SECRET_L1_REASONING_MARKER_42` 断言 L1 散文不出现在 L2 task；`structuredProjection` 丢弃 `raw` 与未知字段 |
| 7 | 只读强制 | ✅ 通过（强于原计划） | `verify-safety.ts`：子进程被要求创建 canary 文件 → **文件未被创建**。原计划的 `tool_call` bash 白名单被更强机制取代：`--tools read,grep,find,ls` 使写工具在子进程中不存在 |
| 8 | 循环有界 | ✅ 通过（发现并修复真实缺陷） | `loop.test.ts` 5/5，覆盖真实 `nextAttempt()` / `decideRetry()`。见下方「验证中发现的缺陷」 |
| 9 | Windows 子进程 | ✅ 通过 | spawn 成功、JSONL 可解析、提取 verdict；`verify-safety.ts` abort 在 8s 内以 SIGTERM 终止子进程 |
| 10 | 项目回归 | ✅ 通过 | `ctest --preset debug --output-on-failure` → `100% tests passed, 0 tests failed out of 10`，含 `arch.layers`、`spec.structure` |
| 11 | 可回退 | ✅ 通过 | `pi -ne` 下注册探针：`review-pipeline` 存在（source=prompt），扩展 `/review` 与 `review_l0_gate` 均不存在 |
| 12 | 交叉审核 | ✅ 通过（找出 2 个真实缺陷，已修复） | 紧约束 reviewer 子进程 `#0fb1f4b74d8746f2` 完成（3 轮 / 17.5k tokens / 1m22s），报告 child.ts 与 verdict.ts 各一处缺陷；均已复现、修复、加回归测试。见下方「验证中发现的缺陷」 |
| — | **全链路（计划步骤 10）** | ✅ **13/13 通过** | `verify-fullchain.ts`：临时 git 沙箱 + **真 cmake/ctest + 真 L1/L2 子进程**，跑完 L0 fail → 修复 → L1 fail（带证据）→ 修复 → L2 → pass。详见下方「全链路实测」 |

## 全链路实测（计划步骤 10 的核心证据）

在临时沙箱项目里用真实工具链与真实 LLM 子进程跑了三轮，**13/13 通过**：

| 轮次 | 代码状态 | 实测结果 |
|---|---|---|
| 1 | `syntax error here!;` | L0 fail；**子进程调用 0 次**；clang 错误原文（`unknown type name 'syntax'`）进入打回文本 |
| 2 | 能编译、ctest 通过，但 `clamp()` 违反注释里写明的闭区间契约 | L0 pass → **L1 fail**；`main.cpp:5` + 触发例 `clamp(11,0,10)` + 修法；**L2 调用 0 次** |
| 3 | 按 L1 证据补上 `if (v > hi) return hi;` | L0 / L1 / L2 **全部 pass** |

L1 实际输出的证据（原文摘录）：

```
- [warning] main.cpp:5
  evidence: 当传入的 v 大于 hi（例如 clamp(11, 0, 10)）时，第 5 行直接返回 v，
            结果为 11，未限制到闭区间 [lo, hi]，违反文件头注释声明的契约。
  fix: 在 v > hi 时返回 hi，并添加覆盖 v > hi 的测试。
```

防串台在**真实子进程输出**上的断言（不只是单测模拟）：
- L2 task 含 L1 的**结构化** verdict（`"layer": "L1"`）✅
- L2 task 含约束清单 ✅
- L1 的**原始输出文本未被粘贴**进 L2 task（`rawLen=108 leaked=false`）✅

### 夹具教训（值得记录）
最初用「`divide()` 未防 b==0」做 bug，全链路跑出 11/13，两个 FAIL。排查后确认：
**那是测试夹具设计问题，不是实现缺陷**——没任何地方规定 `b==0` 的契约，L1 判 pass 是正确的（prompt 明确要求它不编造问题）；第二个断言依赖第一个成立，属连带失败。
换成「注释写明契约、实现违反它」的 `clamp()` 后才成为可判定的真实缺陷，13/13 通过。
**结论：审查需要可对照的契约，不能靠 reviewer「感觉」——这反过来印证了证据标准设计的必要性。**

## 验证中发现并修复的真实缺陷

### 缺陷 1：重试计数被重置，`max_retries` 形同虚设（严重）
- **位置**：`index.ts` 的 `/review` 命令处理器原先无条件 `state.attempt = 0`。
- **触发**：`/review` 打回 → coder 修复 → `agent_settled` 用 `sendUserMessage("/review")` 派发续跑 → 命令处理器再次把 `attempt` 归零 → 永远达不到 `MAX_RETRIES`，**无限循环烧 token**。
- **修法**：新增 `state.continuation` 标志与 `orchestrator.ts` 的 `nextAttempt()` 纯函数。人工输入 `/review` 才重置预算；settle 钩子派发的续跑保留计数。
- **回归测试**：`loop.test.ts` 用真实 helper 重放循环，断言「持续 fail 必在预算内终止」，并反向证明「每轮归零」变体确实无界。

### 缺陷 2：校验器对 L0 强制要求修复建议，与契约冲突
- **位置**：`verdict.ts` 原先对所有层要求 `required_fix` 或 `failing_test`。
- **冲突**：`verdict-schema.md` §3 规则 5 只对 **L1/L2** 要求；§2 明确 L0 只报事实、不得给修复方向。
- **发现方式**：`l0.test.ts` 的「L0 never invents required_fix」用例红灯。
- **修法**：把该检查限定为 `l === "L1" || l === "L2"`。

### 缺陷 3：`extractJson` 把单引号当字符串定界符（严重，由交叉审核发现）
- **位置**：`verdict.ts` 的 `extractJson`，原 `if (ch === '"' || ch === "'")`。
- **触发**：JSON 只允许双引号。任何 JSON 前含**奇数个撇号**的散文（`Reviewer's verdict:`、`I don't see issues`）会让扫描进入字符串态且永不退出，整段 verdict 被跳过 → 返回 `null` → 合法审查被误判「裁决不合规」，触发无谓重试甚至误阻断。
- **实测复现**：`extractJson("Reviewer's verdict:\n{...}")` → `NULL`；`don't` 同样 `NULL`；无散文基线正常。
- **修法**：只以 `"` 进入字符串态；JSON 字符串内的撇号本就被 `inStr` 分支正确忽略。
- **回归测试**：`verdict.test.ts` 新增 3 例（散文撇号、缩写 don't/it's、JSON 值内撇号）。修复前 16 通过 / 2 失败，修复后 **17/17 全绿**。

### 缺陷 4：子进程定时器与已 abort signal 处理（由交叉审核发现）
- **位置**：`child.ts` 的超时/abort 路径。
- **触发 A**：SIGKILL 兜底 `setTimeout(..., 4000)` 未保存句柄、未清理。子进程响应 SIGTERM 退出后，该定时器仍撑住 Node 事件循环最多 4 秒。
- **触发 B**：注册 abort 监听前未检查 `signal.aborted`。传入**已 abort** 的 signal 时事件不会再触发，子进程会跑满 `timeoutMs`（默认 10 分钟）才被杀。
- **修法**：抽出 `terminate()` 统一挂可清理的 SIGKILL 兜底；`clearTimers()` 在 `error`/`close` 两条路径清理全部定时器；注册前判断 `signal.aborted` 并立即 `terminate()`。
- **回归测试**：`verify-safety.ts` 新增「已 abort 的 signal 立即终止」用例，实测 **0s**（超时上限为 180s），3/3 通过。

## 遗留限制（已定位，不影响已完成验证项）

### 活链路续跑（settle 钩子）无法在 print 模式下验证
- **现象**：`pi -p --mode json "/review"` 只发出 `session` 事件，没有后续 agent 轮次。
- **原因**：print 模式不处理扩展注入的后续轮次，`pi.sendUserMessage` 的打回消息不会启动新 turn。
- **性质**：**验证方法的限制，不是实现缺陷**。自动续跑只在 TUI/RPC 下生效。
- **已验证的替代证据**：
  - 命令派发本身已证实：在无改动的临时 git 仓库中 `/review` 返回 exit 0 且**无 assistant 文本**（若未派发，pi 会把 `/review` 当普通 prompt 回答）。
  - 续跑的决策逻辑由 `loop.test.ts` 用真实 helper 覆盖。
- **仍需人工确认**：在 TUI 里跑一次真实 `/review`，观察打回 → 修复 → 自动重跑 → 满 2 轮转人工的完整交互。

## 复现命令

```bash
# 53 项单测
node --experimental-strip-types .pi/orchestrator/tests/review/verdict.test.ts
node --experimental-strip-types .pi/orchestrator/tests/checks/l0.test.ts
node --experimental-strip-types .pi/orchestrator/tests/review/catalog.test.ts
node --experimental-strip-types .pi/orchestrator/tests/workflow/orchestrator.test.ts
node --experimental-strip-types .pi/orchestrator/tests/workflow/loop.test.ts

# 7 项端到端（真 cmake/ctest + 故障注入，finally 逐字节还原 src/assert.cpp）
node --experimental-strip-types .pi/orchestrator/tests/integration/verify-e2e.ts

# 3 项安全（真子进程：只读强制 + abort + 已 abort signal）
node --experimental-strip-types .pi/orchestrator/tests/integration/verify-safety.ts

# 13 项全链路（临时沙箱，真工具链 + 真 L1/L2 子进程，不碰当前仓库）
PI_REVIEW_PI_BIN=<path-to-pi-or-cli.js> \
  node --experimental-strip-types .pi/orchestrator/tests/integration/verify-fullchain.ts

# 项目回归
ctest --preset debug --output-on-failure
```

合计：**53 项单测 + 7 项端到端 + 3 项安全 + 13 项全链路 = 76 项**，全部通过；ctest 10/10。

## 工作区完整性

- 故障注入只改 `src/assert.cpp`，`finally` 中逐字节还原；验证后 `git status --short src/` 为空。
- 只读验证的 canary 文件从未被创建。
- 用户在写的 `docs/platform-abstraction.md`、`specs/README.md`、`specs/spec-screen-frame-handoff.md`、`specs/spec-platform-win.md` **全程未被修改**（活链路测试用 `--no-tools` 让父进程无写权限）。
- 所有临时探针与日志已清理。

## 本期扩展（四层 + 五阶段）验证记录

| 项 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `node --experimental-strip-types --test ".pi/orchestrator/tests/**/*.test.ts"` | **445 项全绿**（含新增 `commands` 12 项、`machine` 28 项） |
| C9 命令接线 | `verify-commands.ts`（真实 `/orch` 处理器 + 假 Pi 宿主，print 模式） | **13/13**：approve 走 SPEC_HUMAN→PLAN_DRAFT、重复 approve 被拒、resume 读 state.json、abort→ABORTED、reject→ABORTED、changes→SPEC_DRAFT、`start discussion` 写 DECISIONS.md |
| C11 全流水线 | `verify-fullpipeline.ts` | **13/13**：讨论→Spec（L0/L1/面板/L3 approve）→Plan（覆盖率 L0/L3）→Task→Code；另测 L0 红零 LLM、覆盖率红列出 PB-02、request_changes/reject、连续 L0 红升级 + 人工恢复、证据链可复算 |
| 项目约束自检 | `ctest --preset debug --output-on-failure` | **10/10**，含 `spec.structure`、`arch.layers` |
| 真实工具链故障注入 | `verify-e2e.ts` | **7/7**（真实编译错误阻断，子进程 0 次） |
| 只读/abort | `verify-safety.ts` | **3/3** |
| 真实模型全链路 | `verify-fullchain.ts`（真 cmake/ctest + 真 L1/L2） | 13/13（本轮重跑，见下方「真实模型回归」） |

### C9 发现并修复的真实缺陷

1. `/orch approve` 原先把下一状态硬编码为 `CODE_LOOP/COMMITTED`，在 `SPEC_HUMAN` / `PLAN_HUMAN` 上会绕过后续阶段。现改为全部走 `applyEvent` 转移表，并由 `commands.test.ts` 逐门禁断言。
2. 升级/终止时 `applyEvent` 把 `stage` 重算成 `code`，导致从 Spec 升级的运行恢复时回到 Code。现升级/终止保留原 stage，`restoreSnapshot` 也保留 `state.json` 里的 stage。
3. print/json 模式下配置错误只调用 `note`（无 UI 时静默）。现在 `/orch` 的所有报告（含配置错误）都镜像到消息流。
4. `listRuns` 返回 safeId 小写目录名，而用户可能输入显示的大小写；`resume` 现按大小写不敏感匹配。
5. `/orch abort` 原先只有 `human-abort`（仅 ESCALATED 可用）；现从任意非终态都可终止，包括 ESCALATED。
### 真实模型回归（C12 重跑）

- `verify-fullchain.ts`（真 cmake/ctest + 真 L1/L2）：**13/13**。期间修复了验证脚本自身的缺陷：未跟踪文件只出现在 diff 的文件名列表里，导致第三轮一行修复不被 diff hash 看见；现用 `git add -N` 让 `git diff` 携带内容，三轮 diff hash 互不相同。
- `verify-four-layer.ts`（真工具链 + 真跨 vendor 面板）：**22/22**。本轮实测 `opencode-go/claude-haiku-5-5` 返回 403（模型访问未开启），面板按设计 BLOCKED 并升级，**没有静默放行**；其余成员正常投票。
- 上述结果与 `ctest 10/10`、`verify-e2e 7/7`、`verify-safety 3/3` 共同构成当前证据。
### C9 交叉审核（验证项 #22）发现并修复的缺陷

用只读 subagent 审计 `commands.ts` / `machine.ts` / `index.ts`（`/orch` 与 `executeFourLayer`）/ `stage-pipeline.ts`，发现并修复 6 处真实缺陷：

1. **state.json 损坏被当成“没有运行”**：`readJson` 同时吞掉“缺失”和“解析失败”。现先检查文件存在；存在但解析失败 → 报错，绝不重置为 DISCUSSION。新增 `commands.test.ts` 覆盖截断 JSON。
2. **ESCALATED 无法恢复**：升级发生在审查包生成之前，`packageHash` 为 null，决定分支在记录前就返回。现在 ESCALATED 的 approve/changes/reject 直接走状态机，并把裁决写入 `escalations/*-human-ruling.json`；无包也能恢复。`verify-commands.ts` 新增两条用例。
3. **request_changes 后 checkpoint 冲突**：checkpoint id 只含 `stage-round`，重跑会命中旧的 `human-decision.json`（拒绝覆盖）而永久卡住。现 id 含 attempt 与 L0 连续失败计数；新增回归测试证明第二次能批准且旧证据保留。
4. **print/json 模式仍会静默**：`/orch start` 的异常与 `executeFourLayer` 的配置错误/no-diff 只调用 `note`。现全部镜像到消息流。
5. **讨论冲突恢复错阶段**：冲突检查在 `decided` 之后，升级时 stage 已变成 spec。现在先判冲突再前进，恢复回到 discussion；测试断言 `machine.stage === "discussion"`。
6. **`human:"risk"` 被静默当成 never**：交付阶段没有风险分级，discussion/task 也没有人工门禁状态。配置校验现在拒绝非 code 阶段的 `"risk"`，以及 discussion/task 的 `human:true`（fail-closed），并新增 3 条配置单测。
7. **`stages.spec.l1=false` 时 L2 面板与 `l2-*` 转移被跳过**（真实 RPC 集成跑发现）：L2 代码块原本嵌套在 L1 的 `else` 里，导致 L3 已批准但状态机仍停在 `SPEC_L2`。现把面板移出 L1 分支，并让 `l2-skipped` 在面板关闭时独立触发；配置校验也拒绝非 spec/code 阶段的 `panel`。新增 2 条阶段单测 + 2 条配置单测。

修复后：23 套单测 **445 项全绿**、`verify-commands.ts` **13/13**、`verify-fullpipeline.ts` **13/13**、`ctest` **10/10**。

### 真实 Pi RPC 命令验证（任务 2）

真实宿主使用 Pi RPC 模式，`/orch` 通过 `prompt` 记录执行，`ctx.ui.select/input` 通过 `extension_ui_response` 协议交互。按当前目录布局复现可用 `pi --mode rpc --no-session -e .pi/extensions/review.ts`。

| 场景 | 结果 |
|---|---|
| `/orch status` | `response: prompt success=true, disposition=handled`，UI `notify` 正常返回 run 状态 |
| 仓库内 `/orch start spec specs/spec-screen-frame-handoff.md` | L0 `python tools/check_specs.py` 退出码 0 → L1 产出 3 条真实 finding（帧槽释放竞态、`stride*height <= frame_bytes` 缺失、lock-free 要求未落地）→ `blocked`，状态回 `SPEC_DRAFT`；spec 文件未被修改 |
| 沙箱探针规格（第一轮） | L1 发现前置条件表述矛盾、缺 `approved-by` 与 §7 并发自检；规格修正后重跑 |
| 沙箱探针规格（第二轮） | L1 报告 `// Thread: any` 不在白名单——**误报**：`docs/threading.md:33` 与 `tools/check_layers.py:70-73` 明确允许 `any`/`none`。没有为让模型通过而改规格，记录为「模型裁决仍需人核验」的实证 |
| 受控集成（沙箱里临时 `stages.spec.l1=false`） | 暴露了缺陷 #7：L3 已批准但状态机停在 `SPEC_L2`。修复后重跑：`L0 pass → L2 面板 PASS 2/2 → L3 approve → PLAN_DRAFT`，`human-decision.json`、`l2-panel.json`、`evidence.sha256`、`status-advice.md` 齐全，spec 第 3 行仍为 `status: draft`，包 hash `39db4147231a…` |

> 受控集成只为隔离验证面板与 L3，使用的是临时沙箱配置；仓库配置仍为 `stages.spec.l1=true`。真实仓库那次运行停在 L1，是审查按设计拦下真实问题，不是失败。
