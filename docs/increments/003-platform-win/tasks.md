# Windows 屏幕采集与输入注入任务清单

## 依据

[003 规格](spec.md) · [技术方案](plan.md) · [M1 T002](../001-android-controls-windows-over-lan/tasks.md)。规格获批后执行，各行为先观察预期断言失败，再实现。

## 波次 1 · 注入记账与释放

- [x] T001 声明公共接口、Windows 注入器及可注入后端，接入可编译测试占位（路径 `src/platform/`、`include/remotedesktop/platform/win/`、`tests/unit/platform/win/`、CTest 接线。验证 `arch.layers` 和可发现性。）
- [x] T002 写并运行 PW-18、PW-21 的 mock 失败测试。分别驱动零接受、明确接受前缀、无法归因的部分计数，以及释放中途失败、桌面不可用和重试（路径 `tests/unit/platform/win/input_inject_win_test.cpp`。验证账项、错误、实际释放顺序和重试调用，保存行为断言红灯。）
- [x] T003 实现 PW-18、PW-21 的记账及逐项释放，重跑红灯用例（路径 `src/platform/win/input_inject_win.cpp`。验证同一断言转绿。）

本波次的 mock 红绿与全量回归证据见 `test-results/m1-t002.md`。原生 `SendInput` 后端由 T005 接入。

## 波次 2 · 其余平台行为

- [x] T004 按红绿循环补齐 DXGI 采集、探测、映射与释放分支（路径 `src/platform/win/screen_capture_win.cpp`、`tests/unit/platform/win/screen_capture_win_test.cpp`。验证 PW-01–08、PW-20。）
- [x] T005 接入原生 `SendInput` 后端，按红绿循环补齐键鼠、文本、映射与生命周期分支（路径 `src/platform/win/input_inject_win.cpp`、`tests/unit/platform/win/input_inject_win_test.cpp`。验证 PW-09–17、PW-19。PW-13 两个配置均须验证。）

波次 2 的红灯、绿灯和全量回归记录见 `test-results/platform-win/wave-2.md`。

## 最终波次 · 验收与证据

- [ ] T006 验证单张纹理的非等待读回和 Windows 真机结果。先在 `tests/unit/platform/win/screen_capture_win_test.cpp` 保存 PW-22–26 的红灯，再实现在 `src/platform/win/` 的提交、轮询、交付和作废行为。运行目标和全量 Debug、Release CTest，在本机交互桌面运行 PWH-01–06。
  - PW-22–26 和 Debug、Release 全量 CTest 已通过。候选在同一台 Windows 电脑通过 PWH-02–06，包括真实锁屏拒绝和解锁后重建采集。PWH-01 的 60 秒测量交付 1,393 帧，颜色全部正确，帧池全部归还，进程私有内存增加 216 KiB，未达标。原始日志和堆分配对照见本地记录 `test-results/platform-win/t006-readback.md`。 [真机运行说明](../../../tests/integration/platform/win/README.md)

## 验收覆盖

| 验收编号 | 对应任务 |
| --- | --- |
| PW-18、PW-21 | T002、T003、T006 |
| PW-01–08、PW-20 | T004、T006 |
| PW-09–17、PW-19 | T005、T006 |
| PW-22–26 | T006 |
| PWH-01–06 | T006 |
