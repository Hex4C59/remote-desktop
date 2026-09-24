# Android → Windows 远程桌面

面向 RTC 视频工程校招的一个月原型：在局域网内，通过 Android 查看 Windows 桌面视频并操作终端。已通过原生 WebRTC 两端构建及真机真实桌面视频、合成视频及消息回显验证，尚未实现完整远程桌面应用。

完整文档入口见 [文档导航](docs/README.md)。

## 已有内容

- [范围与访谈记录](docs/design/project-brief.md)、[领域术语](CONTEXT.md)、[技术路线调研](docs/design/technical-options.md)。
- [Windows 工具链核查](docs/guides/windows-environment.md)。
- Windows 桌面探针：验证构建、进程会话和 Desktop Duplication 单帧访问，不保存屏幕像素。
- SSH 命令、文件上传下载和本地日志保存入口。
- [WebRTC 构建与文件联调](docs/guides/webrtc-probes.md)：Windows C++ 被控端、Android 控制端及合成视频探针。

任务01已完成：[真实桌面验证记录](docs/validation/task01-desktop-video.md)。任务02提供[地址与临时口令连接](docs/design/pairing-protocol.md)，正常使用不再交换SDP文件。任务03已支持[触屏定位与左键点击](docs/design/pointer-input.md)，并通过[真实终端验收](docs/validation/task03-touch-pointer.md)。任务04增加[字符与终端按键](docs/design/terminal-input.md)，包括 Enter、Tab、方向键和 Ctrl+C，见[完整终端会话验收](docs/validation/task04-terminal-input.md)。

## 源码目录

```text
apps/
  windows/src/               Windows 被控端 C++ 实现
  android/src/main/          Android 控制端 Manifest 与 Java 实现
  macos/                     macOS 桌面端预留目录，尚未实现
  linux/                     Linux 桌面端预留目录，尚未实现
probes/
  windows_desktop.cpp        独立的 Windows 单帧采集探针
  webrtc/pattern_source.cpp  合成视频测试源
scripts/                    构建、联调与测量脚本及配置
  webrtc/BUILD.gn            两端共用的 libwebrtc 构建配置
```

平台状态和构建目录映射见 [apps/README.md](apps/README.md)。macOS、Linux 当前仅建立目录，尚无可运行应用；`scripts/linux/` 是 Android 的 Linux 构建入口。

## Windows 桌面探针

要求 Windows、VS2022 C++ 工具和其内置 CMake。此探针使用现有工具链；完整 libwebrtc 的工具链要求单独记录在[候选版本清单](docs/design/webrtc-build-candidate.json)。

在 Windows 项目目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\build-probe.ps1
```

随后从已登录、未锁定的 Windows 本地桌面执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\run-desktop-probe.ps1
```

采集日志位于 `build/windows-probe/interactive-probe.log`。`frame_acquired=true` 且 `exit_code=0` 才表示该次采集成功；SSH Session 0 下跳过桌面检查不代表采集通过。当前探针验证第一个附着的输出，最终应用的显示器选择尚未实现。

## 从 Ubuntu 执行远程操作

连接配置和主机密钥保存在被 Git 忽略的 `.local/windows.json` 和 `.local/windows_known_hosts`，依赖已配置的 SSH 身份。配置格式如下：

```json
{"host": "WINDOWS_IP", "user": "WINDOWS_USERNAME"}
```

首次连接先通过普通 SSH 流程确认并记录主机密钥；辅助脚本使用严格校验，不自动信任新主机。

```bash
python3 scripts/windows-remote.py --script local-command.ps1 --log .local/logs/command.log
python3 scripts/windows-remote.py --upload local-file.txt D:/code/remote-desktop/local-file.txt
python3 scripts/windows-remote.py --download D:/code/remote-desktop/build/windows-probe/interactive-probe.log .local/logs/interactive-probe.log
```

`--script` 通过 PowerShell 编码命令执行本地脚本内容，不提供远端文件的 `$PSScriptRoot`；需要该变量的脚本应先上传，再用短脚本调用其远端路径。构建前须同步修改的源文件。命令超时只代表本地 SSH 等待结束，不能据此断定远端进程已经停止。

## 第一阶段状态

见[验证记录](docs/validation/phase-one-status.md)。Ubuntu 上的 C++ 工具存在不代表 Windows 功能可用；构建通过也不代表媒体互通已经完成。

历史验证记录中的提交编号对应关系见[GitHub 提交映射](docs/validation/git-history.md)。
