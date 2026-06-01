# 第一阶段验证记录

日期：2026-09-22。用户已确认并授权执行。目标是在 2–3 个工作日内验证原生 libwebrtc 两端构建与局域网测试画面、控制消息互通；本阶段构建、局域网测试画面与控制消息互通检查点已通过，最终版本独立启动两轮均通过。

| 检查点 | 当前证据 |
| --- | --- |
| Windows 访问 | 现有 OpenSSH 和密钥登录成功，无需重新配置 SSH |
| 工具链 | 具备 VS2022/VS2026、SDK26100、内置 CMake/Ninja、Android SDK/ADB；已补装并核验 SDK28000 |
| 源码传输 | SFTP 上传 CMake、C++ 源文件和 PowerShell 构建脚本成功 |
| Windows 编译 | CMake + MSVC19.44 Release 编译及远程执行成功 |
| 日志回传 | SSH 输出保存到 Ubuntu `.local/logs/`；命令成功、原生命令失败及 PowerShell 异常的退出码传播实测通过 |
| 桌面访问 | 用户在 Session1 执行探针，输出0为2560×1440，`frame_acquired=true`、`exit_code=0`；日志回传成功。SSH Session0 的枚举失败已明确区别于交互桌面能力 |
| Android 真机 | USB 授权通过；Android16 / API36，arm64-v8a，物理屏幕1220×2656，型号25113PN0EC |
| WebRTC 依赖 | 两端 depot_tools 已按固定 commit 安装并完成引导。SDK28000已安装；Android和Windows源码依赖同步及 hooks 均已通过；Android arm64 APK 编译并安装成功，Windows发送端编译及链接通过 |
| 视频 / 控制互通 | 最终版本两轮各约30秒均通过：手机首帧显示、回包、发送端退出码0 |

## 人工步骤

1. 已完成：从 Windows 已登录桌面运行 `scripts/windows/run-desktop-probe.ps1`，Agent 已读取成功日志。
2. 已完成：将 Android 手机连接 Windows，开启 USB 调试并确认设备上的授权提示，Agent 已核验 ADB 和设备参数。

本机 `.local/device-setup.sh` 为这两个步骤提供临时交互向导，已执行 `bash -n`，未替用户运行；用户已按聊天中的同等步骤完成。人工操作依据为 [Android 官方真机调试说明](https://developer.android.com/studio/run/device)及[Windows 会话边界参考](bootstrap-references.md)。

## 证据边界

当前包含环境探针及开发用 WebRTC 连通性探针，不是已完成的远程桌面客户端。单帧采集成功也不代表达到了 720p、30 FPS 或延迟目标。后续需把桌面采集接入已验证的媒体链路，实现输入控制、配对以及正式性能测量。

## 连通性验证与修复

首个通过运行：`126bb693892a45f9a02004b45202666d`。合成源640×360，每33ms产生一帧，发送约30秒，生成911帧；Android最后一次统计已解码887帧，当前帧率31 FPS、framesDropped=0、packetsLost=0、freezeCount=0，解码实现为libvpx（软件解码）。统计每2秒采样，末次采样不等于发送结束时刻；两端帧数差不能直接解释成丢帧。手机已实际渲染首帧，并收到`echo:probe:1`；发送端退出码0。截图与日志保存在被忽略的`.local/logs/`。

此前两轮暴露并重现了Android网络初始化时序：ICE先在无网络地址时报告COMPLETE，随后才生成候选地址。旧版只在COMPLETE时写SDP，导致Windows拿到没有候选地址的answer，30秒内无画面和回包。修复后，对COMPLETE与候选事件都安排发布，要求SDP非空且含候选，等待500ms候选事件静默后原子发布一次文件。此策略限于开发探针；产品信令应逐条转发候选并处理网络变化，不能把500ms当作网络发现上限。测试未修改Windows防火墙。

PowerShell联调脚本还修复了退出码读取：启动进程后保留句柄，等待退出后才能可靠获取ExitCode。通过条件依然同时检查退出码、首帧和回包，空退出码不会被算作成功。

复现入口：[构建与联调说明](webrtc-probes.md)。当前没有画面显示延迟、操作反馈延迟或720p30十分钟的实测结论。

第二次问题：清理诊断日志后的复跑`9f811f7f6e5644cd8afe4bd512796eea`仍失败，answer虽有候选，却未包含手机当前Wi-Fi IPv4地址；部分候选出现蜂窝地址。该次手机Wi-Fi仍可ping到Windows，不能据此归咎于整个局域网不可达。随后将探针进程绑定Wi-Fi，并忽略蜂窝/VPN适配器，以消除本阶段不需要的多网络参与。底层为何在该次生成这些地址尚未定位到上游根因，不将其宣称为已证实的libwebrtc缺陷。

## 最终版本复跑

| 运行ID | 最后采样解码帧 | 当时FPS | packetsLost | freezeCount | 首帧/回包/退出码 |
| --- | ---: | ---: | ---: | ---: | --- |
| 4f9fb2d94cf5425988cdcf4f580d659c | 884 | 31 | 0 | 0 | true / true / 0 |
| 62aeb2a0c3754b7d962d83dfac9342b4 | 846 | 29 | 13 | 1 | true / true / 0 |

两次均是640×360、软件解码，framesDropped=0，每次15份入站统计。第二轮确有丢包和一次冻结，不能声称无卡顿或完成性能验收；后续需要真实桌面、长时间基线及受控弱网实验。两次都完成首帧与可靠消息往返，因此满足本阶段连通性门槛。

最终APK SHA256：`91530c464e80e2ab11f0aa440df871c332768827dc1ca993baa977cf6736bed0`。结构化、不含SDP凭据的证据摘要见[interop-smoke.json](evidence/interop-smoke.json)。

验证补充：Windows GN头文件依赖检查通过；Android脚本重复构建通过；Python入口语法、PowerShell联调脚本语法及Bash脚本语法已检查。测试应用和发送端已由联调脚本关闭。
