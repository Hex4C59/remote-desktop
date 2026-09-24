# 应用源码

按平台组织应用实现，独立的技术验证程序保留在根目录 `probes/`。

| 目录 | 职责与状态 |
| --- | --- |
| [windows/](windows/README.md) | Windows 被控端，已有桌面采集、视频发送、配对、输入控制与统计日志实现 |
| [android/](android/README.md) | Android 控制端，已有视频显示、配对、触屏/键盘输入、会话管理与视频统计实现 |
| [macos/](macos/README.md) | macOS 桌面端预留目录，尚未实现 |
| [linux/](linux/README.md) | Linux 桌面端预留目录，尚未实现 |

## libwebrtc 构建

当前仍使用固定版本 libwebrtc 的 GN 构建，入口见 [构建说明](../docs/guides/webrtc-probes.md)。两端脚本将源码组装到外部 libwebrtc checkout 的 `remote_desktop_probe/` 下：

| 仓库源码 | 生成目录中的位置 |
| --- | --- |
| `windows/src/*` | `remote_desktop_probe/*` |
| `android/src/main/AndroidManifest.xml` | `remote_desktop_probe/android/AndroidManifest.xml` |
| `android/src/main/java/*` | `remote_desktop_probe/android/*` |
| `../probes/webrtc/pattern_source.cpp` | `remote_desktop_probe/pattern_source.cpp` |
| `../scripts/webrtc/BUILD.gn` | `remote_desktop_probe/BUILD.gn` |

生成目录维持现有 C++ include 路径、GN 目标、Android 包名及产物名称。不要直接把本目录或 `scripts/webrtc/` 复制到 libwebrtc checkout 来构建。

`scripts/linux/build-webrtc-probe.sh` 在 Linux 上构建 Android APK；它不是 Linux 桌面应用的构建脚本。根目录 CMake 仍只构建 `probes/windows_desktop.cpp`，不构建上述应用。

2026-10-10 的目录整理只迁移现有实现并更新构建路径。历史任务与证据中的旧源码路径保留，描述的是当时的源码布局。
