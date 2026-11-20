# 接口核实记录（步骤 0）

核实对象：已安装扩展 `npm:@hex4c59/pi-ext-subagents` v0.1.0（注意包名是复数 **subagents**）。
源码位置：`C:\Users\hex4c59\.pi\agent\npm\node_modules\@hex4c59\pi-ext-subagents\`。

## 结论

| 项 | 结果 |
|---|---|
| LLM 可调用的工具名 | **`subagent`**（单数） |
| 斜杠命令 | **`/subagents`**（复数）：`/subagents [list\|status] \| stop <id> \| steer <id> <msg> \| resume <id> [msg]` |
| 工具 action | `run`（默认）/ `list` / `status` / `steer` / `stop` / `resume` |
| 调用模式 | **single**：`{agent, task, model?, thinking?}`；**parallel batch**：`{tasks:[{agent,task,...}], concurrency?}`。**没有 chain 模式**，无 `{previous}` 占位符。 |
| 报告投递（TUI/RPC） | `run` 立即返回 run id（后台）；完成后以 `customType:"pi-subagents-result"` 的 steer 消息注入父会话，标记为 **UNTRUSTED**。也可 `action:"status"` + `id` 轮询，`record.output` 含最后一条 assistant 文本（截断 50KB）。 |
| 报告投递（print/json） | 工具结果内联返回完成报告。 |
| Agent 发现目录 | 用户级 `~/.pi/agent/agents/*.md`；项目级 `<repo>/.pi/agents/*.md`（仅项目受信任时加载，同名项目覆盖用户，用户覆盖内置）。 |
| frontmatter 字段 | `name`（必填，正则 `^[a-z0-9][a-z0-9_-]{0,63}$`）、`description`（必填非空）、`tools`（逗号串或数组）、`model`（可选，须在父会话允许范围内）、`thinking`（可选 off/minimal/low/medium/high/xhigh/max）。 |
| tools 白名单 | `read, grep, find, ls, bash, powershell, edit, write`。出现白名单外的工具名 → 该 agent **整个被跳过**（不报错，静默忽略）。未声明 tools → 默认只读。 |
| 内置 agent | `scout`（只读勘察）、`worker`（可写，串行）、`reviewer`（只读）。 |
| 子进程隔离 | 独立 `pi --mode rpc` 进程，独立上下文/会话；不开放 MCP，不允许嵌套 subagent。同 cwd 同 OS 权限，非沙箱。 |
| 运行目录 | `getAgentDir()/subagents/<workspace-hash>/<parent-session-id>/runs/<run-id>/`，含 `run.json`、`events.jsonl`、agent prompt 副本、子会话 JSONL。 |

## 对本方案设计的影响

1. **不能用 chain 传裁决**（接口无此能力）。L0→L1→L2 必须由编排器用 single 模式依次调用，**手动**解析上一层 verdict 再构造下一层 task。
2. **纯资源版（主 agent 当编排器）**：主 agent 调用 `subagent` 后需用 `action:"status"` 轮询取报告，或等待 steer 消息；然后自行解析 verdict JSON。
3. **硬化扩展版**：在 TUI/RPC 下 `ctx.executeTool("subagent", {action:"run",...})` 会立即返回 run id（后台），编排器需在命令处理器中轮询 `action:"status"` 直至终态，再提取 `output`。不能假设同步返回 verdict。
4. **agent 文件名/name 必须全小写且匹配正则**，否则静默不加载——写 agent 定义时务必遵守。
5. L1/L2 设为只读（tools 不含 bash/edit/write）时，扩展的 `tool_call` 白名单钩子是**额外**保险，不依赖它作为唯一防线。
6. L1/L2 子进程同 cwd 同权限，**不是沙箱**；防串台靠"不把推理文本放进 task"，而非靠权限隔离。

## 模型选择（成本分层）

父会话默认 `hellocode/gpt-6-luna`（thinking max）。L1/L2 应指定较省的模型。`models.json` 中 hellocode 可用：gpt-6-luna / gpt-6-astra / gpt-6.2-astra / gpt-6.1-sol / gpt-6.2-sol / gpt-6.1-terra；另有 github-copilot 的 gpt-4.1 / gpt-4o。
各档成本未在配置中标注，暂不在 frontmatter 硬编码 model（避免指定到不可用/更贵的模型），继承父模型；在 README 中说明可自行在 frontmatter 加 `model:` 字段降本。
