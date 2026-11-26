# Windows 屏幕采集与输入注入任务清单

## 依据

[003 规格](spec.md) · [技术方案](plan.md) · [M1 T002](../001-android-controls-windows-over-lan/tasks.md)。规格获批后执行，各行为先观察预期断言失败，再实现。

## 波次 1 · 注入记账与释放

- [x] T001 声明公共接口、Windows 注入器及可注入后端，接入可编译测试占位（路径 `src/platform/`、`include/remotedesktop/platform/win/`、`tests/unit/platform/win/`、CTest 接线。验证 `arch.layers` 和可发现性。）
- [x] T002 写并运行 PW-18、PW-21 的 mock 失败测试。分别驱动零接受、明确接受前缀、无法归因的部分计数，以及释放中途失败、桌面不可用和重试（路径 `tests/unit/platform/win/input_inject_win_test.cpp`。验证账项、错误、实际释放顺序和重试调用，保存行为断言红灯。）
- [x] T003 实现 PW-18、PW-21 的记账及逐项释放，重跑红灯用例（路径 `src/platform/win/input_inject_win.cpp`。验证同一断言转绿。）

本波次的 mock 红绿与全量回归证据见 `test-results/m1-t002.md`。原生 `SendInput` 后端由 T005 接入。

## 波次 2 · 其余平台行为

- [ ] T004 按红绿循环补齐 DXGI 采集、探测、映射与释放分支（路径 `src/platform/win/screen_capture_win.cpp`、`tests/unit/platform/win/screen_capture_win_test.cpp`。验证 PW-01–08、PW-20。）
- [ ] T005 接入原生 `SendInput` 后端，按红绿循环补齐键鼠、文本、映射与生命周期分支（路径 `src/platform/win/input_inject_win.cpp`、`tests/unit/platform/win/input_inject_win_test.cpp`。验证 PW-09–17、PW-19。PW-13 两个配置均须验证。）

## 最终波次 · 验收与证据

- [ ] T006 运行全量 Debug CTest 和 Windows 平台实测。记录每条验收的被测版本、命令、结果与环境（路径 `tests/integration/`、`test-results/platform-win/`。验证 PWH-01–06 及回归。）

## 验收覆盖

| 验收编号 | 对应任务 |
| --- | --- |
| PW-18、PW-21 | T002、T003、T006 |
| PW-01–08、PW-20 | T004、T006 |
| PW-09–17、PW-19 | T005、T006 |
| PWH-01–06 | T006 |
