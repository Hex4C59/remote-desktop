# Windows 桌面状态观察技术方案

## 规格与工程约束

依据 [005](spec.md)、[平台抽象 §5](../../architecture/platform-abstraction.md#5-会话与桌面状态) 和 001 的 M1 关断顺序。使用 C++20、Windows SDK 和现有测试框架。沿用 Session 及平台事件源已有线程。

## 模块与数据流

| 模块 | 职责 |
| --- | --- |
| `src/platform/win/session_state_win.cpp` | Session 通过此观察器安装和撤销订阅 |
| `src/platform/win/desktop_event_source_win.cpp`、`desktop_signals_win.cpp` | 现有 Session 线程处理 WTS 与 WinEvent。事件源发布有代次和序号的快照及变化 |
| `src/session/` | 调用订阅，用同代次的最新快照或通知更新桌面状态。通过预分配的门禁与槽处理关断和恢复 |
| `tests/unit/platform/win/` | 用可控事件源安排订阅失败、快照与通知交错、撤销和在途通知 |
| `tests/unit/session/` | 用同步点控制门禁封闭与 Input 许可顺序，断言平台收到的调用及异步关断结果 |

## 技术决策与风险

- Windows 事件源使用当前会话的 WTS 通知和桌面切换 WinEvent。Session 所有者调用 `DesktopEventSourceWin::pump_notifications()`，在既有线程消费平台消息并按需探测，订阅安装和撤销也在此线程执行。回调只发布已知的不可交互状态或标记待探测。确认会话活跃且解锁并读到默认输入桌面后才发布 `kInteractive`。无法证实桌面身份时报告 `kUnknown`。真机覆盖由 DSH-01 验证。
- 发布器为每个订阅维护序号。门禁与两个槽采用代次校验，记录最新状态的操作校验序号。不可交互的发布不得被后续恢复合并。
- 观察器接口、快照及订阅寿命测试纳入 M1 T002。真实 Session 与 Input 的原子顺序测试纳入 T006。关断回调和事件源退出通过已有生命周期通路确认。

## 验证与交付

目标用例前缀 `platform.win.desktop_state.` 和 `session.desktop_gate.`。按 005 验收表记录红绿结果，并运行全量 `ctest --preset debug --output-on-failure`。Windows 台架运行 DSH-01，保存状态、序号、代次与关断证据至 `test-results/windows-desktop-state/`。
