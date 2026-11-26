# Android 控制端技术方案

## 规格与工程约束

按 007 规格实现 Android 10+ ARM64 控制端。会话行为遵循 001 与协议 v1。首版侧载调试 APK，使用同一局域网内直连的手机和 Windows 电脑验收。[007 规格](spec.md) · [001 会话总契约](../001-android-controls-windows-over-lan/spec.md) · [控制协议](../../protocol/README.md)

### 本机构建准备

构建和测试版本以 007 §6.1 为准。Windows 本机 SDK 根目录为 `D:/Dev/SDKs/Android`，JDK 目录为 `D:/Dev/Runtimes/Java/Eclipse Adoptium/jdk-17.0.19.10-hotspot`。工程通过 `JAVA_HOME` 选择 JDK，通过 `ANDROID_HOME` 或本地 `sdk.dir` 查找 SDK。[固定版本表](spec.md#61-构建工具和测试依赖)

本机 SDK 的 CMake `3.22.1` 低于仓库顶层 `cmake_minimum_required(VERSION 3.28)`。007 获批后，T001 准备 SDK 包 `cmake;3.31.6`。Gradle 通过 `externalNativeBuild` 调用版本表中的 NDK 和 CMake，使用 Ninja 构建共用 C++20 组件，再通过 JNI 装配。仓库根目录继续用 `debug` preset 构建 Windows 端并验证共用 C++。[AGP 官方兼容表](https://developer.android.com/build/releases/agp-8-13-0-release-notes) · [安装及配置 NDK 和 CMake](https://developer.android.com/studio/projects/install-ndk) · [AndroidX Test 发布说明](https://developer.android.com/jetpack/androidx/releases/test)

## 模块与数据流

| 路径或模块 | 工作与所有权 |
| --- | --- |
| `src/platform/android/` | Java Activity 提供地址、配对确认、状态、视频视口和键鼠入口。JNI 转交带代次的值和 Surface 引用。主线程发布焦点和表面生命周期事件 |
| `src/app/client/` | 组装公共 Session、Transport、Decode 和 Writer 与 Android 平台接口。Session 核验当前尝试、会话与表面，独占状态迁移 |
| `src/platform/android/` 的解码适配 | Decode 检查媒体能力，持有一个 `MediaCodec`、表面引用及至多一个应用待输出。将匹配代次的系统呈现回调送入首帧槽 |
| `src/transport/`、`src/session/` | 共用 001 和协议 v1。Network 独占认证和套接字，Session 决定信令与退出，Writer 异步持久化 |
| `src/input/` 与 Android UI | 通过当前呈现矩形和远端映射生成平台无关输入，带代次送入独立有界队列。停止输入和退出走独立槽 |

## 技术决策与风险

- 用系统 `MediaCodec` 向 Surface 输出。用替身控制能力查询、输出索引、首帧回调和退出顺序，用真机记录当前设备的解码与呈现结果。回调耗时和物理可见反馈分别度量。
- JNI 在提交表面时获取异步引用，由 Decode 在停止提交、归还缓冲并释放解码器后归还。Surface 失效与首帧回调按表面代次隔离。输入的像素域及视频裁切元数据由获批媒体和输入契约绑定，联调前验证坐标边界。

## 从本地样片到双机联调

| 阶段 | 开始条件与检查结果 |
| --- | --- |
| 工程与本地验证（T001–T003） | 007 获批后准备工程和测试替身。T001 核对固定版本及手机，T002–T003 用替身或本地样片检查界面、Surface 和解码行为 |
| 仅查看（T004） | 手机通过 T001 预检，001 T003–T004 的连接、配对和本机授权契约已获批并实现，003 原生采集和 001 T007 的获批媒体契约及编码链路就绪。与 001 T007 共同检查 `view` 会话，以 ANH-01 确认可见桌面且无普通注入 |
| 键鼠（T005） | 仅查看通过，001 T005–T006 的输入与关断契约已获批并实现，003 注入与 005 桌面状态已接入。001 T007 与 T005 定义并测试坐标绑定，然后按 ANH-02–03 验证操作、暂停和清理 |
| 双机验收（T006） | 用同一候选 APK 和被控端执行 ANH-01–03 及 001 M1H-01–06 |

具体依赖见 007 §6.3。[联调前置条件](spec.md#63-平台准备仅查看与键鼠联调的前置条件)

## 验证与交付

T001 在 `src/platform/android/` 执行 `gradlew.bat --version` 和 `gradlew.bat assembleDebug testDebugUnitTest`。核对 Gradle 与 JDK 版本、原生构建记录中的 SDK、NDK 和 CMake，以及调试 APK 中原生库的 ABI。保存至少一个实际执行的 JVM 用例结果。

记录 `adb version`，用 `adb devices -l` 选择用户指定的实体手机，核对型号、系统构建、API 和 ABI，执行 `gradlew.bat connectedDebugAndroidTest`。至少执行一个设备用例，核对样片可见画面和当前 Surface 的匹配回调。按 007 §6.2 将预检证据保存到 `test-results/m1/`。无设备时记录未验证，未达条件时记录失败点。[手机准入条件](spec.md#62-首台验收手机的准入条件)

C++ 运行 `cmake --preset debug`、`cmake --build --preset debug -j` 和 `ctest --preset debug --output-on-failure`。各行为先保存预期断言失败，再记录目标用例及回归结果。

ANH-01–03 与 M1H-01–06 使用 Android 和 Windows 真机在同一局域网内执行。记录 APK 与被控端版本、手机型号、系统、解码器、刷新率、网络链路及原始时序。验收证据归入 `test-results/m1/`，依照 [001 §4.2](../001-android-controls-windows-over-lan/spec.md#42-真机验收) 计算各类反馈 P95 和统计覆盖率。
