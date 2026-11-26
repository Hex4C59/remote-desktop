# Windows 桌面状态观察任务清单

## 依据

[005 规格](spec.md) · [技术方案](plan.md) · [M1 任务](../001-android-controls-windows-over-lan/tasks.md)。按规格获批、红灯、实现和验收的顺序推进。

## 波次 1 · M1 T002 观察器

- [x] T001 声明观察器接口，接入可脚本化状态源及可运行目标（路径 `src/platform/`、`tests/unit/platform/win/`。验证 `arch.layers` 和用例可发现性。）
- [x] T002 先写失败测试，再实现快照、订阅和撤销的观察器逻辑（路径 `src/platform/win/session_state_win.cpp`、`tests/unit/platform/win/session_state_win_test.cpp`。验证 DS-01–03、DS-06 的观察器断言。）

本波次的 mock 红绿与全量回归证据见 `test-results/m1-t002.md`。

## 波次 2 · M1 T006 关断交接

- [ ] T003 用同步点驱动两种封闭顺序、满队列、恢复和旧通知，记录红灯后实现（路径 `src/session/`、`src/input/`、`tests/unit/session/`。验证 DS-02–06 的会话断言和 M1U-30。）

## 最终波次 · 验收与证据

- [x] T004 实现由 WTS 与输入桌面观察驱动的 Windows 事件源（路径 `src/platform/win/`、`tests/unit/platform/win/`。验证事件归一化、快照顺序和注册撤销。）
  证据见 `test-results/005-t004.md`，包含 7 项红绿用例、全量 Debug 回归和本机原生注册烟测。
- [ ] T005 运行全量 Debug CTest 与 DSH-01 真机测试，记录状态序列及关断和清理结果（路径 `test-results/windows-desktop-state/`。）

## 验收覆盖

| 验收编号 | 对应任务 |
| --- | --- |
| DS-01 | T002、T004、T005 |
| DS-02–03、DS-06 | T002、T003、T004、T005 |
| DS-04–05 | T003、T005 |
| DSH-01 | T004、T005 |
