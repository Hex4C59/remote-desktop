# Windows 开发环境核查

核查日期：2026-09-22。通过已有 SSH 连接执行只读 PowerShell 查询；未安装软件或修改远端配置。本文不记录连接地址、账户名和用户目录。

## 系统与硬件

| 项目 | 实测结果 |
| --- | --- |
| 系统 | Windows 11 家庭版，10.0.26100，build 26100 |
| CPU | AMD Ryzen 7 9700X，8 核 / 16 线程 |
| 内存 | 系统报告约 31.1 GiB 可用物理内存总量 |
| 磁盘剩余空间 | 系统卷约 110.7 GiB，数据卷约 431.9 GiB；随使用变化 |
| 独立 GPU | NVIDIA GeForce RTX 5070 Ti；驱动版本 32.0.15.9159；查询时显示模式 2560 × 1440 |
| 其他显示设备 | AMD Radeon Graphics；GameViewer Virtual Display Adapter |

## C++ 工具链

通过 Visual Studio Installer 的 `vswhere` 和工具版本命令核查：

| 组件 | 实测版本 |
| --- | --- |
| Visual Studio Build Tools 2022 | 17.14.37614.0 |
| 对应 MSVC 工具集 | 14.44.35207 |
| 对应内置 CMake / Ninja | 3.31.6-msvc6 / 1.12.1 |
| Visual Studio Community 2026 | 18.8.12009.203 |
| 对应 MSVC 工具集 | 14.51.36231 |
| 对应内置 CMake / Ninja | 4.3.1-msvc1 / 1.13.2 |
| Windows SDK Include 目录版本 | 10.0.26100.0 |
| PATH 中的 clang / clang-cl | 22.1.8，目标 x86_64-pc-windows-msvc |
| Git | 2.49.0.windows.1 |

两个 Visual Studio 安装都具备 `vcvars64.bat`。普通 SSH shell 的 PATH 不含 CMake/Ninja，但安装内置版本可执行。后续构建应显式选择一个工具链并初始化其开发环境；尚未执行编译或 libwebrtc 构建验证。

`python` 指向已有 Miniconda Python；本轮只检查路径，未执行或确认版本。`python3` 指向 WindowsApps 别名，未启动它。

## Android 工具

Windows 已有 Android SDK，`ANDROID_HOME` / `ANDROID_SDK_ROOT` 指向同一安装；`adb` 与 `sdkmanager` 可从 PATH 定位。

| 组件 | 实测版本或安装目录 |
| --- | --- |
| ADB | 1.0.41，platform-tools 37.0.0-14910828 |
| SDK platforms | android-28、android-31、android-35、android-36 |
| Build Tools | 35.0.0、35.0.1、36.0.0、36.1.0 |
| NDK | 25.2.9519653、28.0.13004108、28.2.13676358 |
| SDK 内置 CMake | 3.22.1 目录存在，未执行版本核验 |
| Command-line Tools | latest 目录存在，未核验具体版本 |

本轮没有连接或枚举 Android 真机，设备授权与部署链路尚未验证。

## 交互会话与远程运行边界

- 已有 SSH 通道能够执行远端命令。
- 查询发现交互会话 1 中存在 `explorer` 进程；`quser` / `query` 在当前 shell 不可用。
- `explorer` 存在不证明桌面当前未锁定，也不证明 SSH 启动的进程能采集该交互桌面。采集原型仍须验证用户桌面中的启动和日志回传流程。
- Tailscale 不在 PATH，默认 Program Files 安装路径下也未找到；未广泛扫描，不能据此认定没有安装。
- 当前机器存在实体与虚拟显示设备，采集原型应枚举显示器并显式选择目标，避免依赖枚举顺序。

## 同日执行阶段更新

- CMake + VS2022/MSVC19.44 已完成桌面探针的 Release 构建和远程执行；探针固定使用 SDK26100，避免安装新 SDK 后悄然改变该验证环境。
- SSH 进程实测位于 Session0。用户从 Session1 启动探针后，取得2560×1440桌面帧，日志回传成功。
- Android USB 调试已授权，设备为 Android16/API36、arm64-v8a、1220×2656；手机到 Windows 的两次 ICMP 探测成功，往返约16ms，不能等同于媒体端到端延迟。
- 已安装微软签名有效的 SDK10.0.28000.2270，安装器退出码0。确认 Include/Lib/bin 的10.0.28000.0目录及 x64调试工具存在。原SDK26100仍存在，没有执行重启。
- SDK安装器SHA256：`e9f1bde566381355e594e2f90daf4f714eb5c7ef2c45c501ce236afe2abea300`；下载与参数依据见[准备参考](bootstrap-references.md)。
