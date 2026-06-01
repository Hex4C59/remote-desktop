# WebRTC 两端连通性探针

这是开发阶段的 **640×360 合成视频 + DataChannel 文本回显**，不是远程桌面产品。Windows 单帧桌面采集另由 `windows_desktop.cpp` 验证，尚未接入视频发送。探针没有产品配对、输入注入或公网服务；SDP 经 SSH/ADB 文件交换，仅用于自有设备开发测试。

## 固定源码与工具链

版本见 `webrtc-build-candidate.json`。源码不放进项目仓库：Ubuntu 为 `/home/aimsl/tools/remote-desktop/webrtc-android/src`，Windows 为 `D:\tools\remote-desktop\webrtc-windows\src`，各自的 `depot_tools` 与 checkout 根目录并列。

在安装固定 depot_tools 后，为 checkout 根目录准备 `.gclient`：

```python
solutions = [{"name": "src", "url": "https://webrtc.googlesource.com/src.git",
              "deps_file": "DEPS", "managed": False, "custom_deps": {}}]
# 仅 Ubuntu 构建 Android 时加这一行：
target_os = ["android", "unix"]
```

将 depot_tools 加入当前进程 PATH，关闭其自动更新（`DEPOT_TOOLS_UPDATE=0`），Windows 再设置 `DEPOT_TOOLS_WIN_TOOLCHAIN=0`。Windows 首次需执行官方 `bootstrap\win_tools.bat` 完成 depot_tools 引导。运行：

```text
gclient sync --nohooks --no-history --revision src@a3553f1c82a5580c91ad1f82baab4b11ed4b34b6 -j4
gclient runhooks
```

Windows 当前路线使用 VS2026 C++ 工具和 SDK28000.2270（包括 Debugging Tools）。Android 由 WebRTC/Chromium 自带 GN、SDK/NDK/JDK 构建，不依赖系统 Gradle；当前仅验证 arm64-v8a。下载失败再按工作区网络规则进行临时代理重试。

## 构建

Ubuntu：

```bash
bash scripts/linux/build-webrtc-probe.sh /home/aimsl/tools/remote-desktop/webrtc-android/src 16
```

APK 输出：`out/remote-desktop-arm64/apks/RemoteDesktopProbe.apk`。此探针关闭 Chromium Android 静态分析，编译通过不代表完成全部静态检查。

Windows 项目目录下：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\build-webrtc-probe.ps1 -WebRtcRoot D:\tools\remote-desktop\webrtc-windows\src
```

输出：`out\remote-desktop-win\sender.exe`，构建日志在项目 `build\webrtc-sender-build.log`。两端脚本校验 WebRTC commit，并把项目探针复制到外部 checkout 的 `remote_desktop_probe` 目录构建。

## 真机联调

手机通过 Wi-Fi 与 Windows 网络互通，手机 USB 连接 Windows、允许调试与 APK 安装，解锁并保持应用在前台。将 APK 复制到 Windows 后执行：

```powershell
adb -d install -r D:\code\remote-desktop\build\RemoteDesktopProbe.apk
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\run-webrtc-probe.ps1 -Sender D:\tools\remote-desktop\webrtc-windows\src\out\remote-desktop-win\sender.exe
```

每次运行创建独立 `build\interop\<run-id>`，保存发送端日志、手机应用日志、SDP 和 `result.json`。SDP 含连接信息，仅存放被 Git 忽略的构建目录。运行脚本自动启动合成发送端、交换 SDP、收集日志，结束后关闭该次发送端与测试应用。

通过条件同时满足：发送端正常退出、Android `first_frame_rendered=true`、Android `data_received=echo:probe:1`。`inbound_stats` 可核验实际解码帧和丢包；此短测试不能证明 720p30 稳定性，也不能把网络 RTT 当作端到端画面延迟。

用户中途切后台会释放连接；重新运行脚本创建新会话，不支持应用内重连。探针使用默认协商编码器，后续应结合实际协商和设备硬件能力选择桌面编码方案。实际进度见 [第一阶段验证记录](phase-one-status.md)。

## 局域网与网络初始化边界

探针在创建WebRTC工厂前通过`ConnectivityManager.bindProcessToNetwork`绑定当前Wi-Fi，并在工厂选项里忽略蜂窝和VPN适配器。绑定仅影响测试应用进程，结束时解除；Wi-Fi不可用时显示失败，不回退到蜂窝。此行为符合本阶段LAN范围，不是后续公网连接策略。API语义见[Android官方说明](https://developer.android.com/reference/android/net/ConnectivityManager#bindProcessToNetwork(android.net.Network))。

Android网络回调可能晚于首次ICE COMPLETE。文件信令因此等待含候选地址的SDP，候选事件静默500ms后原子发布一次，脚本再原子送入Windows。这个快照机制仅供固定网络下的短探针使用，不承担网络切换或无限延迟候选；正式应用需独立实现候选转发及会话生命周期。
