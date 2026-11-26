# Windows 控制端渲染表面任务清单

## 依据

[006 规格](spec.md) · [技术方案](plan.md)。Windows 控制端按本增量推进，Android 首发验收见 [001 M1](../001-android-controls-windows-over-lan/tasks.md)。

## 波次 1 · 平台表面

- [ ] T001 声明平台接口和 mock 图形后端，接入可运行测试目标（路径 `src/platform/`、`tests/unit/platform/win/`。验证 `arch.layers` 和用例可发现性。）
- [ ] T002 先写失败测试再实现像素检查、目标尺寸、呈现结果及资源重建（路径 `src/platform/win/render_surface_win.cpp`、`tests/unit/platform/win/render_surface_win_test.cpp`。验证 RS-01–03 的平台断言。）

## 波次 2 · 代次、首帧与退出

- [ ] T003 先写失败测试再接入一槽移交、首帧及退出回执（路径 `src/app/`、`src/session/`、`tests/integration/`。验证 RS-03–05 的会话断言及 M1U-06、M1U-23 的渲染路径。）

## 最终波次 · 验收与证据

- [ ] T004 运行全量 Debug CTest 与 RSH-01 真机用例，按验收编号记录结果（路径 `test-results/windows-render-surface/`。）

## 验收覆盖

| 验收编号 | 对应任务 |
| --- | --- |
| RS-01–02 | T002、T004 |
| RS-03 | T002、T003、T004 |
| RS-04–05 | T003、T004 |
| RSH-01 | T004 |
