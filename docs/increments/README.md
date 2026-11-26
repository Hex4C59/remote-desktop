# 增量索引

| 编号 | 增量 | 状态 | 范围 | 实施文档 |
| --- | --- | --- | --- | --- |
| 001 | [Android 手机在局域网远控 Windows 电脑](001-android-controls-windows-over-lan/spec.md) | `approved` | 配对与电脑本机授权、手机查看实时桌面、触控与键盘操作、延迟与一小时稳定性验收 | [方案](001-android-controls-windows-over-lan/plan.md) · [任务](001-android-controls-windows-over-lan/tasks.md) |
| 002 | [屏幕帧移交](002-screen-frame-handoff/spec.md) | `approved` | 帧所有权、缓冲池与单槽覆盖 | |
| 003 | [Windows 平台适配](003-platform-win/spec.md) | `approved` | DXGI 画面采集与 SendInput 输入注入 | [方案](003-platform-win/plan.md) · [任务](003-platform-win/tasks.md) |
| 004 | [Android 被控端画面采集](004-android-screen-capture/spec.md) | `draft` | 系统授权、真机像素取帧与资源回收 | [方案](004-android-screen-capture/plan.md) · [任务](004-android-screen-capture/tasks.md) |
| 005 | [Windows 桌面状态观察](005-windows-desktop-state/spec.md) | `approved` | 初始快照、会话代次通知与输入关断 | [方案](005-windows-desktop-state/plan.md) · [任务](005-windows-desktop-state/tasks.md) |
| 006 | [Windows 控制端渲染表面](006-windows-render-surface/spec.md) | `approved` | 解码帧借用、窗口呈现与首帧确认 | [方案](006-windows-render-surface/plan.md) · [任务](006-windows-render-surface/tasks.md) |
| 007 | [Android 控制端](007-android-controller/spec.md) | `draft` | 实时画面、触控与键盘、焦点和表面生命周期 | [方案](007-android-controller/plan.md) · [任务](007-android-controller/tasks.md) |

**下一个可用编号 008**

## 目录与顺序

每个增量使用一个 `docs/increments/<NNN>-<slug>/` 目录。`NNN` 从 `001` 起全局递增，`slug` 用小写英文、数字和连字符。保留已登记的目录名及编号，规格被替代时在原目录登记状态和替代文件。功能规格应链接所属里程碑，或说明独立交付的边界。

1. 根据[规格模板](../templates/spec.template.md)编写 `spec.md`，记录范围、完整行为契约、不变量与编号验收场景。在索引登记并更新下一个编号。
2. 根据规格和[方案模板](../templates/plan.template.md)编写同目录的 `plan.md`，记录模块、工具链、关键取舍、风险和验证方式。
3. 根据方案和[任务模板](../templates/tasks.template.md)编写同目录的 `tasks.md`。任务按波次排列，写明 `T###`、改动路径和验证方式，末尾将规格的验收编号映射到任务编号。同一波次的 `[P]` 任务须相互独立且修改不同文件。

评审期间可以逐步补齐三份文档。行为变更先改规格，再同步方案和受影响的任务。进入 TDD 前须有获批规格和可执行任务。

## 审批状态

规格第 3 行使用 `status: draft` 等机器可读的状态行，非 `draft` 规格在第 4 行记录 `approved-by: <批准人, 日期>`。状态由用户批准或明确指示变更。

| 状态 | 含义 |
| --- | --- |
| `draft` | 草案，可编写和评审方案与任务 |
| `approved` | 契约获批，可按方案及任务进入 TDD |
| `implemented` | 三份文档齐备，验收场景逐项关联实际运行的测试或实测证据 |
| `superseded` | 已被其他规格取代，在原规格中链接替代文件 |

## 自动校验

[结构检查器](../../tools/check_specs.py) 检查编号目录、索引和规格状态、必需章节、验收编号，以及文档齐备与顺序。通过 CTest 的 `spec.structure` 或以下命令运行。

```bash
python tools/check_specs.py
```

增量规格定义功能行为和验收结果。[架构总览](../architecture/overview.md)与[线程模型](../architecture/threading.md)定义模块边界和线程归属。调改契约时按影响范围同步相关文档。
