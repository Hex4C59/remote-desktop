# Android → Windows 远程桌面

面向 RTC 视频工程校招的局域网原型：Android 手机连接已登录的 Windows 电脑，查看实时桌面，并通过触屏和终端按键操作。项目自己组织桌面采集、帧提交、配对、输入和会话流程，复用原生 libwebrtc 的编解码、加密与传输能力。

当前是开发原型，不是完整远程桌面产品。

## 当前状态

已通过真机验证：

- Windows 真实桌面经 libwebrtc 发送到 Android 显示。
- 地址加 64 字符临时口令配对，正常使用不需要交换 SDP 文件。
- 触屏定位与左键点击；英文、数字、符号及 Enter、Tab、方向键、Ctrl+C。
- 同时只允许一个活动控制端；结束会话、断线或切后台后由用户手动重连。
- 视频码率与帧率统计；Windows 本地软件耗时和操作到反馈帧耗时测量。
- 十分钟局域网基线已采集。

尚未完成或未验收：

- 十分钟 720p30 目标未达到；弱网带宽、延迟、丢包实验正在实施，瓶颈优化对照尚未开始。
- 物理画面显示延迟和操作反馈延迟未测量，不能用软件耗时替代。
- DXGI 鼠标光标未合成；多显示器、macOS 与 Linux 桌面端尚未实现。

## 构建与运行

### 前置条件

- Windows 被控端：已登录、未锁屏的交互桌面。桌面探针使用 VS2022 C++ 工具；WebRTC 两端构建使用 VS2026 C++ 工具和 Windows SDK 10.0.28000。
- Android 控制端：arm64-v8a 真机，Android 8.0（API 26）以上。
- libwebrtc 源码与 depot_tools 放在仓库外，版本固定在 `scripts/webrtc/webrtc-build-candidate.json`。升级版本必须重新验证两端构建与互通。
- Android 在 Linux（开发环境为 Ubuntu）上构建，使用 WebRTC 自带的 GN、SDK/NDK/JDK，不依赖系统 Gradle。

### Windows 被控端

在仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\build-webrtc-probe.ps1 -WebRtcRoot <webrtc-src>
```

输出为 `<webrtc-src>\out\remote-desktop-win\sender.exe`。脚本把 `apps/windows/src/`、`apps/android/src/main/`、`probes/webrtc/*.cpp` 和 `scripts/webrtc/BUILD.gn` 组装到外部 checkout 的 `remote_desktop_probe/` 后再构建。

### Android 控制端

```bash
bash scripts/linux/build-webrtc-probe.sh <webrtc-src> 16
```

输出为 `<webrtc-src>/out/remote-desktop-arm64/apks/RemoteDesktopProbe.apk`。安装到已授权的设备：

```powershell
adb -d install -r <webrtc-src>\out\remote-desktop-arm64\apks\RemoteDesktopProbe.apk
```

### 连接

1. 在 Windows 交互桌面运行 `<webrtc-src>\out\remote-desktop-win\sender.exe --serve`。配对窗口显示电脑 IPv4 地址、端口 `18443` 和 64 字符临时口令，口令 5 分钟内有效，只接受一个会话。
2. 在 Android 应用输入 `电脑IPv4:18443` 和口令，点击“连接”。
3. 点击“结束会话”主动结束。切后台、离开应用或网络断开也会结束当前会话，需要手动重连。

手机与电脑须在同一可互通局域网。连接失败时先检查地址和口令是否过期，再检查 Windows 防火墙是否允许 TCP 18443 入站。

## 源码结构

```text
apps/
  windows/src/                    Windows 被控端 C++ 实现
  android/src/main/               Android 控制端 Manifest 与 Java 实现
  macos/、linux/                  桌面端预留目录，尚未实现
probes/
  windows_desktop.cpp             独立的 Windows 单帧采集探针
  webrtc/pattern_source.cpp       合成视频测试源
  webrtc/software_trace_smoke.cpp 软件阶段写盘冒烟测试
scripts/
  webrtc/BUILD.gn                 两端共用的 libwebrtc 构建配置
  webrtc/webrtc-build-candidate.json  固定的 WebRTC 与工具链版本
  windows/                        Windows 构建、联调与验证脚本
  linux/                          Android APK 的 Linux 构建入口
  latency/                        软件耗时、基线与弱网结果分析
tools/network-shaper/             Windows 网络限流工具
```

平台状态与生成目录映射见 [apps/README.md](apps/README.md)。`build/` 和 `.local/` 被 Git 忽略，用于构建产物、日志和本地配置。

## Windows 桌面探针

该探针验证 Windows 桌面采集能力，不经过 WebRTC。要求 Windows、VS2022 C++ 工具及其内置 CMake。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\build-probe.ps1
```

构建完成后，从已登录、未锁定的 Windows 本地桌面执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\run-desktop-probe.ps1
```

采集日志位于 `build/windows-probe/interactive-probe.log`。只有 `frame_acquired=true` 且 `exit_code=0` 才表示该次采集成功；SSH Session 0 下跳过桌面检查不代表采集通过。当前探针验证第一个附着的输出，最终应用的显示器选择尚未实现。

## 测量与实验

- `scripts/latency/` 用同一时钟记录重算软件阶段耗时、十分钟基线和独立弱网实验，只依赖 Python 标准库。检查命令：`python -m unittest discover -s scripts/latency -p "test_*.py"`。
- `tools/network-shaper/` 是基于 WinDivert 2.2.2-A 的 Windows 限流工具，构建入口为 `scripts/windows/build-network-shaper.ps1`。实验一次只改变带宽、延迟或丢包中的一项，结束后恢复网络设置。
- 软件处理耗时、操作到反馈帧耗时和物理画面延迟是不同指标，名称与边界见 [CONTEXT.md](CONTEXT.md)。构建通过、单次合成视频或短时探针均不能证明真机链路、720p30 或性能验收通过。
