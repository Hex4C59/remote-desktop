# 开发环境核查

2026-09-22 只读检查结果。本文记录环境事实，不代表技术选型或安装计划已批准。

| 项目 | 当前结果 |
| --- | --- |
| 本机系统 | Ubuntu 24.04.3 LTS，x86_64 |
| C++ 构建工具 | PATH 中可用 CMake 3.28.3、Ninja 1.11.1、Clang 18.1.3、GCC 13.3.0 |
| Java | PATH 中没有 java/javac；`/home/aimsl/tools/jdk21` 下的 JDK 21.0.11 可运行 |
| Gradle | PATH 中没有 gradle；本机存在 Gradle 9.4.1 wrapper 缓存 |
| Android SDK | PATH 中没有 adb/sdkmanager，检查的常见 SDK 目录不存在；具体安装状态及路径尚不明确 |
| SDK 环境变量 | ANDROID_HOME、ANDROID_SDK_ROOT、JAVA_HOME 未设置 |
| Windows 开发连接 | 项目尚无 Windows 构建、远程执行或 CI 配置；用户已确认拥有 Windows 电脑 |
| Android 真机 | 用户已确认拥有，设备型号、系统版本及调试连接尚未核查 |

没有安装软件、连接远程设备或修改全局环境。PATH 中不存在某项工具不代表整台机器没有安装该工具。

## 第一阶段执行后的补充

以上表格保留初始只读快照。后续已建立 Windows SSH/SFTP 构建和日志回传，补装 SDK28000，完成两端 WebRTC 依赖同步；Android 使用源码树内 SDK/NDK/JDK 构建，真机 APK 安装通过。最新证据见 [第一阶段验证记录](../validation/phase-one-status.md) 和 [探针复现流程](webrtc-probes.md)。
