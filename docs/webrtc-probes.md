# WebRTC 两端连通性探针

本页描述文件联调模式；正常连接见[临时配对与信令](pairing-protocol.md)。

这是开发阶段的**可切换视频源 + DataChannel 文本回显**：默认640×360合成画面，`desktop`模式采集Windows真实桌面并等比缩放至1280×720范围内，不放大小分辨率。独立单帧采集探针仍保留。探针没有产品配对、输入注入或公网服务；SDP 经 SSH/ADB 文件交换，仅用于自有设备开发测试。

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

## 真实桌面模式（任务01）

在Windows已登录、未锁屏的交互桌面打开PowerShell执行；SSH Session0不能采集桌面：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\run-webrtc-probe.ps1 -Sender D:\tools\remote-desktop\webrtc-windows\src\out\remote-desktop-win\sender.exe -Source desktop
```

在另一个交互PowerShell窗口执行 `scripts\windows\show-desktop-fixture.ps1`，放大字体并保持窗口在前台。它展示PowerShell命令结果和每秒变化的计数，60秒后退出循环。测试内容不注入远端输入。实际显示测试应在该窗口可见时运行。

桌面模式在两次间隔7秒的手机截图中取证；自动结果比较发送端实际输出尺寸与接收显示尺寸，要求首帧与消息回显。自动检查通过后`passed`仍为null、`visual_review`为required：需要读取两张截图，核验终端文字可读且计数或桌面窗口发生变化，再单独记录视觉验收。原始桌面截图可能含个人信息，仅保留在本地忽略目录，公开摘要只记录测试结果。

桌面视频设置30 FPS上限、4 Mbps码率上限及保持分辨率偏好；这些是配置，不是实测保证。`desktop_frame`记录源/输出尺寸，`codec_stats`与`inbound_stats`通过codecId关联实际协商编码和解码实现。

### 生命周期与积压边界

FrameSource的构造、初始化、取帧、销毁都由发送主循环线程负责，D3D设备和立即上下文不跨线程调用；PeerConnection信令由独立线程处理。主循环每约33ms同步采集/转换并提交一帧，不额外排入采集任务队列；慢处理会降低实际帧率，项目侧只保留一个最新输出帧引用。转换期间的纹理、I420及旋转缓冲为有界临时资源；交给WebRTC的帧不再修改，基础库持有的缓冲不计作项目队列。静态桌面超时会复用最近画面；没有首帧时不发送空帧。

每次成功AcquireNextFrame都在退出路径释放，映射纹理在转换后解除映射。结束或出错时释放帧源和媒体对象。显示模式变化、采集访问丢失会报错退出，需要重新启动；任务01不处理锁屏、安全桌面或自动恢复。DXGI独立鼠标指针尚未合成，鼠标交互留待后续任务；旋转路径已有实现，但真机证据仅覆盖当前横屏设备。

DXGI画面格式、旋转和独立指针行为依据[Microsoft Desktop Duplication说明](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api)。
