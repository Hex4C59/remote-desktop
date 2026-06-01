# Issue tracker: Local Markdown

本仓库的规格与任务以 Markdown 文件保存在 `.scratch/`。

## 文件约定

- 每个功能一个目录：`.scratch/<feature-slug>/`。
- 规格：`.scratch/<feature-slug>/spec.md`。
- 实现任务：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号，每个任务独立成文件。
- 规格与任务的顶部使用 `Status:` 行记录分类状态；标签含义见 `docs/agents/triage-labels.md`。
- 评论和讨论历史追加到文件底部的 `## Comments` 下。

## 技能操作

“发布到 Issue Tracker”表示在上述路径创建 Markdown 文件；修改已有规格或任务时更新原文件并保留讨论历史。

“读取相关任务”表示读取用户指定的文件。仅给编号时，在对应功能的 issues 目录查找；若跨功能存在同号任务且上下文无法确定，先确认所属功能。

## Wayfinder 操作（使用该技能时）

- 地图：`.scratch/<effort>/map.md`，包含 Notes、Decisions-so-far、Fog。
- 子任务：`.scratch/<effort>/issues/<NN>-<slug>.md`，问题写入正文。
- `Type:` 使用 `research`、`prototype`、`grilling` 或 `task`。
- Wayfinder 子任务使用独立生命周期：`Status: open`、`Status: claimed`、`Status: resolved`；这些不是 triage 分类标签。
- 依赖写为 `Blocked by: NN, NN`；全部依赖 resolved 后才解除阻塞。
- 下一项工作：按编号选择 open 且依赖已解除的任务。
- 开始前保存 `Status: claimed`；完成后在 `## Answer` 追加结果，设置 resolved，再把摘要与链接追加到地图的 Decisions-so-far。
