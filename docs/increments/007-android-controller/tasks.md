# Android 控制端任务清单

## 依据

按 [007 规格](spec.md)、[技术方案](plan.md) 和 [M1 任务清单](../001-android-controls-windows-over-lan/tasks.md) 执行。规格获批后按波次保存行为断言的红灯、绿灯和回归证据。

## 波次 1 · 工具链与接口

- [ ] T001 在 007 获批后准备 Android 工程，按 §6.1 核对固定工具链并构建调试 APK。工程和预检证据分别放在 `src/platform/android/` 和 `test-results/m1/`。[固定版本表](spec.md#61-构建工具和测试依赖)
  - 执行 `gradlew.bat --version` 和 `gradlew.bat assembleDebug testDebugUnitTest`。核对原生构建所用 SDK、NDK 和 CMake，确认 APK 仅含 `arm64-v8a` 原生库，并保存至少一个实际执行的 JVM 用例结果。
  - 选择用户指定的实体手机，核对系统构建、API 和 ABI，执行 `gradlew.bat connectedDebugAndroidTest`，保存至少一个设备用例结果。按 §6.2 记录解码器、样片可见画面和匹配的 Surface 回调。无设备记为未验证，未达条件时记录失败点。[手机准入条件](spec.md#62-首台验收手机的准入条件)
- [ ] T002 声明 UI 与 JNI 的类型、入口和所有权，接入可控制会话、编解码和平台回调的测试替身（路径 `src/platform/android/`、`src/app/client/`、`include/remotedesktop/`。验证测试可观察携带代次的事件、回执和资源释放。）

## 波次 2 · 配对、授权与仅查看

- [ ] T003 按红绿循环接入 Android 配对与授权界面、状态快照、MediaCodec 和 Surface。在 `src/platform/android/`、`src/app/client/`、`tests/integration/` 中用本地样片或替身覆盖 AN-01–03，检查短码错误、拒绝授权、不支持的媒体参数和过期首帧回调。
- [ ] T004 与 001 T007 联调同一个 `view` 检查点。开始前确认 T001 真机预检通过，001 T003–T004 的获批连接与授权契约及实现、003 的 Windows 原生采集、001 T007 的获批媒体契约及编码链路均就绪。在 `src/platform/android/` 和 `src/app/client/` 装配真实链路，执行 ANH-01，确认 Windows 本机批准仅查看后，Android 可见真实桌面且 Windows 的普通注入次数为零。将结果保存到 `test-results/m1/`。

## 波次 3 · 输入与生命周期

- [ ] T005 在仅查看检查点通过后联调触控、键盘、焦点和表面生命周期。前置条件为 001 T005–T006 的输入与关断契约已获批并实现，003 注入与 005 桌面状态已接入，且 001 T007 与 T005 对裁切区、Windows 单显示器物理像素域和 `display_map_version` 的绑定已有契约及测试。按红绿循环在 `src/platform/android/`、`src/input/`、`src/app/client/` 和 `tests/integration/` 验证 AN-04–07，覆盖黑边和边界映射、输入上限、恢复使用新代次及旧 Surface 回调失效。双机按 ANH-02–03 检查输入、暂停、退出及清理。

## 最终波次 · 真机验收与证据

- [ ] T006 用同一候选 APK 与 Windows 被控端完成 ANH-01–03 及 001 的 M1H-01–06，运行 Android 自动化测试和 C++ 全量 Debug 回归（路径 `test-results/m1/`。记录设备、构建版本、链路、状态和指标原始样本，按编号核对验收结果。）

## 验收覆盖

| 验收编号 | 对应任务 |
| --- | --- |
| AN-01–03 | T003、T006 |
| AN-04–07 | T005、T006 |
| ANH-01 | T004、T006 |
| ANH-02–03 | T005、T006 |
| M1H-01–06 | T006、001 T008 |
