# Windows 控制端渲染表面技术方案

## 规格与工程约束

依据 [006](spec.md)、[平台抽象 §7](../../architecture/platform-abstraction.md#7-渲染表面控制端) 和 [001](../001-android-controls-windows-over-lan/spec.md)。使用 Windows SDK、C++20 和现有测试框架，沿用 Decode 与 UI 线程。按 006 任务推进 Windows 控制端，M1 Android 首发路径见 [007](../007-android-controller/plan.md)。

## 模块与数据流

1. Decode 将拥有像素的最新帧与会话及协商代次写入一槽。UI 取帧后校验代次，生成只在调用期间有效的 `VideoFrameView`。
2. `src/platform/win/render_surface_win.cpp` 检查像素范围，准备或复用图形目标，计算居中矩形并由图形后端呈现。UI 所有者处理资源重建和尺寸变化。
3. UI 通过现有一槽回执通知 Session 当前代次首次呈现。Session 复核代次并通知 Network 发送 `session.ready`。退出走相同生命周期边沿。

## 技术决策与风险

- 采用 Windows 自带的 D3D11 与 DXGI，UI 复用上传纹理和呈现缓冲。图形后端的忙碌、遮挡、资源丢失和不可恢复失败分别映射到 006 的公开结果。用 mock 驱动这些结果，用 RSH-01 验证实际呈现路径。
- BGRA8 是 Decode 到 UI 的明确交接格式。解码格式转换留在解码侧，按 M1 测量报告转换与上传成本。
- 使用不会等待垂直同步的提交方式。后台无法接收当前帧时丢掉该帧，输入采集及后续 UI 调度继续。

## 验证与交付

用 `ctest --preset debug -R 'render_surface|first_frame' --output-on-failure` 跑目标用例，再跑全量 Debug CTest。Windows 控制端执行 RSH-01，记录尺寸、呈现状态及首帧时间。证据保存在 `test-results/windows-render-surface/`，旧版 Windows 控制端的验收预算沿用 [001 §4.2](../001-android-controls-windows-over-lan/spec.md#42-真机验收) 的测量方法，记录独立的 Windows 设备和链路条件。
