# 首阶段环境准备参考

核验日期：2026-09-22。本文仅记录官方依据与执行建议；未安装软件、未修改 Windows 配置，也不替代技术选型决策。

## Windows OpenSSH

- 微软推荐 Windows 内置的 OpenSSH 可选功能；安装前检查 Windows 版本、PowerShell 和管理员权限。功能查询入口为 `Get-WindowsCapability -Online`，服务端功能名为 `OpenSSH.Server~~~~0.0.1.0`，安装入口为 `Add-WindowsCapability`。[安装文档](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)
- 安装后通过 `Start-Service sshd` 启动；自动启动可用 `Set-Service -Name sshd -StartupType Automatic` 配置。检查 `OpenSSH-Server-In-TCP` 是否存在并启用，它放行 TCP 22；不要通过关闭整个防火墙解决连通性。[安装文档](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)
- 普通用户的公钥放在用户目录的 `.ssh/authorized_keys`；默认管理员用户匹配规则改用 `%ProgramData%\ssh\administrators_authorized_keys`。确认实际 `sshd_config`，不能给所有账户一律写用户目录文件。[服务端配置](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)
- 管理员公钥文件必须限制 ACL：移除继承，仅保留 SYSTEM 与 Administrators 访问。中文系统可使用 SID，Administrators 为 `*S-1-5-32-544`；操作时先检查现有 ACL，避免遗留其他显式授权。只分发公钥，私钥留在客户端。[密钥管理](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)
- 执行建议：先保存现有配置与 ACL，追加指定公钥，不覆盖已有有效密钥；验证密钥登录后再讨论禁用密码。首阶段 SSH 用于同步源码、构建、无桌面单测和回收日志。

## SSH 与交互桌面不是同一验收条件

Windows 服务默认使用非交互 window station，服务不能直接与用户桌面交互；微软给出的跨会话方案需要显式进入交互用户上下文。`DuplicateOutput` 还受桌面权限与会话断开等条件影响。[Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)、[DuplicateOutput](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput)

据此作出的项目建议：**SSH 成功不代表从 SSH 启动的程序能采集当前显示器或注入输入。** 首阶段在 Windows 已登录、未锁定的本地桌面中手动启动采集测试进程，SSH 只读取结果。先记录进程 session、采集错误和显示输出，不把黑屏直接归因于编码器。这里没有声称所有 SSH 子进程必定处于某个固定 session。

## WebRTC Windows 构建版本

WebRTC 的前置环境页指向 Chromium Windows 构建说明，但该 WebRTC 页面也仍有旧 Visual Studio 版本文字，不能脱离源码版本照抄。[WebRTC 前置环境](https://webrtc.googlesource.com/src/+/main/docs/native-code/development/prerequisite-sw/)

本次核验的 **Chromium main 已要求 Visual Studio 2026 >=18.0.0**，而非 VS2022；页面列出 Desktop development with C++、MFC/ATL、Windows 11 SDK `10.0.28000.2270`，并说明使用 clang-cl 但仍依赖 VS 头文件、库和工具。[当前 Windows 构建说明](https://chromium.googlesource.com/chromium/src/+/main/docs/windows_build_instructions.md)

不能据此立即要求用户升级：WebRTC 的 `DEPS` 固定了 `src/build`、工具和其他依赖版本；应先选定 WebRTC commit，读取该版本的 `DEPS` 与依赖中的 `vs_toolchain.py`/Windows 配置，确认它支持哪代 VS 和 SDK。**本阶段没有核定一个可承诺的 VS2022 最低版本。** 若保留已有 VS2022，必须为具体 revision 验证，而非称其支持当前 main。[WebRTC DEPS](https://webrtc.googlesource.com/src/+/main/DEPS)

## Android 构建与产物记录

官方 Android 原生开发使用 Linux，入口是 `fetch --nohooks webrtc_android`、`gclient sync`、GN 与构建工具；架构由 `target_cpu` 选择，SDK/NDK 随依赖获取。[Android 开发](https://webrtc.googlesource.com/src/+/main/docs/native-code/android/README.md)

官方提供 `tools_webrtc/android/build_aar.py`，可按架构构建并打包 Android AAR；具体选项以选定 revision 的脚本为准，不把普通应用的 Gradle 编译与 libwebrtc 原生构建混为一谈。[AAR 脚本](https://webrtc.googlesource.com/src/+/master/tools_webrtc/android/build_aar.py)

项目建议的版本记录规则：Windows 库与 Android AAR 尽量取同一 WebRTC commit；保存 `DEPS` 对应依赖、depot_tools 版本、GN 参数、工具链版本、ABI、产物 SHA-256 和构建日志。该规则是可复现性建议，并非协议规定两端必须同版。避免直接跟随移动的 `main`，也不在未核验前混用第三方预编译包。

## SDK 28000.2270 安装候选（仅调研，未执行）

微软下载页明确列出 June 2026 的 Windows SDK `10.0.28000.2270`；应选择该行 Installer，而不是页面顶部更新版本。[下载清单](https://learn.microsoft.com/en-us/windows/apps/windows-sdk/downloads)

- 官方固定版本入口：[linkid=2370315](https://go.microsoft.com/fwlink/?linkid=2370315)。本次解析到 [Microsoft 安装器](https://download.microsoft.com/download/78b533c3-6724-4e28-a984-b9fa93265781/KIT_BUNDLE_WINDOWSSDK_MEDIACREATION/winsdksetup.exe)。
- 建议下载到专用工具目录，保存 SHA-256 与 Microsoft Authenticode 签名核验结果，再执行。安装目标是增加 `Include/Lib/10.0.28000.0`，保留已有 `26100`；安装前后分别清点版本目录。不同 SDK 的共享工具可能被更新，不能把“并存”解释成完全不改共享文件。
- 未找到可直接引用、明确对应此 release 的 VS2026 SDK component ID；不建议猜测 component 或 winget 包 ID。独立安装器是已核验来源的入口。

已查证的静默参数依据：微软维护的 eBPF 项目提供下面的 **仅调试工具** 安装形式，包含提权、等待、静默、不重启。它没有证明 C++ headers/libs 的全部 feature ID 或默认组件集合。[微软示例](https://github.com/microsoft/ebpf-for-windows/blob/main/.github/skills/debug-crash-dump/SKILL.md)

```powershell
# 仅作命令候选；假设当前目录已有签名核验后的固定版本安装器。
Start-Process -FilePath .\winsdksetup.exe -ArgumentList '/features','OptionId.WindowsDesktopDebuggers','/quiet','/norestart' -Verb RunAs -Wait
```

因此完整 SDK 的可复核路径是：先在 Windows 上读取该安装器的帮助/功能清单，再确定 Desktop C++ x64/x86 和 Debugging Tools 的 feature IDs；尚未核验前通过安装界面选择这些组件更可靠，不能把上面的调试工具命令当作完整 SDK 安装。安装后检查 `Include\10.0.28000.0\um\Windows.h`、`Lib\10.0.28000.0\um\x64\kernel32.lib` 和 `Debuggers\x64`，再运行固定版本 WebRTC 工具链检查。

`-Verb RunAs` 可能需要交互 UAC，普通 SSH 会话不能保证能完成。若 SSH 进程本身已具备提升权限，可讨论直接等待安装进程并收集退出码；当前没有核验该机器的提升状态，也未执行安装。微软示例的提权形式仅作为依据，不是要求绕过 UAC。
