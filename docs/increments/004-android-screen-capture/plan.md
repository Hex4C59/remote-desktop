# Android 被控端画面采集技术方案

## 规格与工程约束

以 [Android 采集规格](spec.md) 为准，首轮验收设备为 Android 14+ ARM64 真机。Java 模块和 Gradle Wrapper 拟放在 `src/platform/android/`。在评审中同步落实平台目录和 Gradle 构建入口，以及 Android 主线程与 Capture 线程的职责映射和异步交接。关联条款见 [仓库约定](../../../AGENTS.md#3-技术栈与工具链锁定)、[平台抽象](../../architecture/platform-abstraction.md) 和 [线程模型](../../architecture/threading.md)。

在项目根继续使用 CMake `debug` preset 验证 C++ 回归。在 Android 模块目录使用同一套固定版本的 Gradle Wrapper、本机 JDK 和 Android SDK 构建 APK 和运行测试。具体 SDK、JDK、AGP、Gradle 及测试依赖版本由首个任务核对并锁定。

## 模块与数据流

| 模块 | 职责 |
| --- | --- |
| Android Activity 与前台服务 | 在主线程发起系统授权、校验授权结果所属的请求，按规格启停前台服务，显示一致的状态快照 |
| `ScreenCaptureControl` 与采集执行器 | 收敛开始和停止命令，在 Capture 线程管理投影、虚拟显示和图像读取器。通过代次丢弃过期结果，串行归还资源 |
| 帧检查与测试探针 | 按实际行步幅和像素步幅读取图像，验证边界和尺寸。探针用固定测试画面的取样点验证颜色，输出验收结果和统计 |

系统授权成功后，先启动投影前台服务，再获取 `MediaProjection`、注册回调并创建一次 `VirtualDisplay`，由 `ImageReader` 提供 RGBA 帧。Capture 线程在回调内验证并关闭 `Image`。系统撤销、本地停止、尺寸变化和平台异常沿同一串行路径释放资源。

## 技术决策与风险

- 采用 `ImageReader` 作为首轮输出，可以直接用已知色块验证实际像素。编码器 Surface 适用于后续编码增量。
- 复用一个 Capture 执行器，应用帧队列容量为零。用平台替身覆盖旧回调、启动失败及停止交错，用真机检查 SDK 阶段开销和连续启停。
- 尺寸变化按规格结束当次采集。用可控尺寸事件覆盖终止原因，并在真机重新授权时检查首帧尺寸。
- 待评审项以规格第 6 节为准，包含工具链、Android 线程映射和主线程与 Capture 的交接约定。

## 验证与交付

- `AC-01`～`AC-08` 通过 Android 构建入口运行自动化测试。用平台替身验证状态和资源回收，用合成像素验证行尾填充及缓冲区边界。为新增行为保存目标测试的红灯和绿灯。
- `ACH-01`～`ACH-04` 使用同一候选 APK，在 Android 14+ ARM64 真机验证像素、终止和重复启停。证据写入 `test-results/android-capture/`，保存环境、候选版本、命令、结果和采集统计。
- 交付前执行 `python tools/check_specs.py`、`cmake --preset debug`、`cmake --build --preset debug -j` 和 `ctest --preset debug --output-on-failure`。按 [实施任务](tasks.md) 核对所有验收编号。
