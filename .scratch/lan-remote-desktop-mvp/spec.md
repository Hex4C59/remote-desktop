# Android 控制 Windows 的局域网远程桌面 MVP

Status: ready-for-agent

测试边界：用户已确认以 Android 真机与 Windows 被控端的完整会话作为主要验收边界。
基线：`b916443`，第一阶段环境、构建及合成视频互通验证已通过。
范围：整月 MVP；此状态表示可开展后续实现，不表示产品功能或性能验收已完成。

2026-09-27 测量范围调整（用户确认）：当前无法外部拍摄，任务07先实现 Windows 本地软件处理耗时和控制端操作到反馈帧耗时，任务08—11以这些软件指标推进基线、弱网、优化和阶段演示。原定义的物理画面显示延迟、操作反馈延迟延期且保持未验收；不以软件指标等价替换，不宣称原完整端到端验收通过。真实反馈视频帧关联的可行性须先验证，不能用消息回显代替。下文关于物理延迟的用户故事和定义保留为后续目标。

2026-10-12 实施口径（用户确认）：任务07使用通用桌面操作，变化候选辅助定位并人工逐帧确认完整反馈；起点在输入校验通过后、DataChannel.send前，终点在控制端VideoSink.onFrame入口，均用elapsedRealtimeNanos。每次保留前1秒/后5秒完整解码图像，最多两个待处理帧引用，项目图像缓冲64 MiB上限；反馈边界存在缺口则不完整。四类操作各1次预热、5次正式尝试，全部正式边界复读，保留失败并报告中位数与范围。Windows以steady_clock观测采集、GPU读回、转换、旋转、缩放和同步Push返回；旧帧复用的未执行阶段不适用。开关测量各做120秒同负载对照。任务08预热30秒、同一授权会话600秒，五轮120秒C++编辑/编译/运行/中断，各轮四类反馈，共20次；分别判断采集完成和720p30达标。具体复现与边界见[软件测量指南](../../docs/guides/software-measurement.md)及[基线指南](../../docs/guides/lan-baseline.md)。

2026-10-13 复核委托（用户要求“你帮我做了啊,我授权你完成”）：剩余视觉判读、全部正式边界复读及五轮负载核对由Agent完成，本次软件测量／基线采集以明确标注的AI视觉复核结项。必须实际读取图像，候选与OCR不等于复核；同一AI复读不冒充独立或人工复核。原采样协议与人工专属条件的历史记录保留，人工作业数量仍为0，不能宣称原人工条件满足。两类物理显示延迟延期不变。软件参考值仅使用无边界缺口的有效样本。


## Problem Statement

用户希望通过 Android 手机查看并操作 Windows 电脑，在真实桌面中的终端进行编程。仅传输 CLI 文本无法满足查看桌面和操作反馈的要求。最终使用场景是外出后连接家中电脑，但当前没有公网服务器，第一版先完成局域网流程。

项目主要用于 RTC 视频工程岗位校招展示。用户具备 C++ 基础、尚无音视频经验，由一人和 Agent 协作，每天投入约 4–5 小时，期望约一个月完成。项目需要提供可运行、可解释、可复现的媒体链路，以及真实测量支持的性能分析和一项优化对照。

现有代码分别证明了 Windows 单帧桌面采集能力，以及 Windows 到 Android 的合成视频和消息回显能力；还不能通过手机操作真实 Windows 桌面。

## Solution

提供一个局域网远程桌面原型：用户在已开机、已登录且未锁定的 Windows 桌面手动启动被控端，看到临时配对口令；在 Android 控制端输入电脑地址和口令，连接后观看一个显示器的桌面视频，通过触屏定位及英文输入操作终端。

第一版同时只接受一部手机。手机断网、退出或切到后台后结束当前会话并释放远端按键状态；回到前台由用户手动重连。正常使用不依赖 ADB 或手工交换 SDP，SSH 与 USB 调试仅用于开发、部署及证据回收。

按“真实桌面可看 → 终端可操作 → 配对与会话完整 → 性能可测”的顺序集成，正式验收时全部满足。以正常局域网 720p30、连续操作 10 分钟为初步性能目标，当前先测量本地软件处理耗时和操作到反馈帧耗时，并展示码率、帧率以及弱网下的流畅度和恢复情况；物理画面显示延迟和操作反馈延迟后续补测。选择一个实测主要瓶颈完成优化前后对比。

## User Stories

以下故事中的 remote programmer 为远程编程用户，project developer 为项目开发者；controller 和 controlled endpoint 分别对应领域术语“控制端”和“被控端”。

1. As a remote programmer, I want to start the controlled endpoint manually on my logged-in Windows desktop, so that I can make the computer available when needed.
2. As a remote programmer, I want Windows to display a temporary pairing code when the program starts, so that I can authorize my phone without registering an account.
3. As a remote programmer, I want to enter the computer address manually on Android, so that I can connect without device discovery.
4. As a remote programmer, I want to enter the pairing code on Android, so that only an authorized session can view and control the desktop.
5. As a remote programmer, I want an incorrect pairing code to prevent desktop viewing and input, so that a failed pairing does not grant partial access.
6. As a remote programmer, I want to see whether a connection succeeds or fails, so that I know when the desktop is ready to use.
7. As a remote programmer, I want to see live video of one Windows display, so that I can work with the actual desktop and its terminal.
8. As a remote programmer, I want terminal text to remain usable on my phone, so that I can read commands, output, and errors while programming.
9. As a remote programmer, I want touch positions to correspond to positions in the displayed desktop, so that I can focus the terminal and place the pointer accurately.
10. As a remote programmer, I want to enter English letters, so that I can type commands and source code.
11. As a remote programmer, I want to enter digits and symbols, so that I can use arguments, paths, operators, and punctuation.
12. As a remote programmer, I want an Enter key action, so that I can execute a terminal command.
13. As a remote programmer, I want a Tab key action, so that I can use terminal completion.
14. As a remote programmer, I want directional key actions, so that I can move through terminal history and edit a command.
15. As a remote programmer, I want a Ctrl+C action, so that I can interrupt a foreground terminal process.
16. As a remote programmer, I want to see the result of each remote operation on my phone, so that I can tell whether the operation took effect.
17. As a remote programmer, I want only one phone to control the computer at a time, so that concurrent sessions cannot mix their input.
18. As a remote programmer, I want leaving the controller app to end the current session, so that desktop control does not continue in the background.
19. As a remote programmer, I want a network disconnection to end the session and release pressed keys, so that the computer is not left with stuck input.
20. As a remote programmer, I want to reconnect manually after returning to the app or restoring the network, so that I can deliberately resume control.
21. As a remote programmer, I want the desktop to remain operable during a ten-minute LAN session, so that I can complete a short programming task.
22. As a remote programmer, I want to see frame-rate and bitrate measurements, so that I can recognize changes in video quality and delivery.
23. As a project developer, I want to measure screen-change-to-display latency, so that I can evaluate how promptly the controller displays Windows updates.
24. As a project developer, I want to measure input-to-visible-feedback latency separately, so that I can evaluate the actual interaction experience.
25. As a project developer, I want to test bandwidth limitation independently, so that I can understand its effect on video and interaction.
26. As a project developer, I want to test added network delay independently, so that I can distinguish network delay from other processing costs.
27. As a project developer, I want to test packet loss independently, so that I can observe freezes, recovery, and input feedback under loss.
28. As a project developer, I want to compare one bottleneck before and after optimization under equivalent conditions, so that performance claims have measurable support.
29. As a project developer, I want repeatable builds, launches, and log collection on the real devices, so that I can reproduce failures and demonstrations.
30. As a project developer, I want versioned specifications and verification summaries, so that I can distinguish completed work from plans and unresolved decisions.
31. As a project developer, I want to organize the core flow and explain its thread and frame-queue behavior, so that the project demonstrates my engineering work in interviews.
32. As a project developer, I want to reuse mature codec, encryption, and transport infrastructure, so that I can complete the project without implementing an entire RTC stack.

## Implementation Decisions

1. **平台与运行环境**：Windows 被控端以 C++ 实现，Android 控制端以 Java 接入。被控端运行在已登录的交互桌面；SSH 后台会话只承担开发协作。控制端使用与电脑可互通的局域网 Wi-Fi。先支持一个显示器和一个活动控制端。
2. **核心流程归属**：不改造现成完整远程桌面产品。项目自己组织桌面采集、视频帧进入媒体链路、显示、输入、会话生命周期和统计；复用原生 libwebrtc 的媒体链路及 DataChannel，以及成熟的编解码和加密实现。无需为展示个人工作而重新实现 libwebrtc 内部线程、编解码器或拥塞控制。
3. **版本与工具链**：继续使用已通过两端探针的固定 WebRTC 版本及构建流程。版本升级须重新验证构建与互通。现有成功只证明当前设备与工具链可用，不承诺其他设备或某种硬件加速方案。
4. **桌面视频模块**：将已验证的 Desktop Duplication 采集能力接入媒体发送。实现采集帧格式转换、按需缩放与媒体帧提交；在控制端解码并显示真实桌面。以 720p30 为初步目标，具体编码器、码率控制配置和硬件加速选择由实际设备验证确定。
5. **帧与线程边界**：明确采集、帧处理、媒体提交和界面操作的执行上下文及对象生命周期，管理项目侧帧队列、时间戳和背压，避免慢消费者导致无界积压。队列容量、丢弃策略及是否涉及基础库修改由基线定位后的设计确定，规格不预先声称某一策略就是主要瓶颈的解法。
6. **连接与配对模块**：提供手动地址输入和临时配对口令，不引入账户系统。认证成功前不得提供桌面视频或执行远端输入。错误口令应得到可识别的失败结果。具体口令生命周期、认证流程、信令保护及其与媒体会话身份的绑定需在该模块实现时明确并记录；媒体链路加密不能替代连接授权，不自行设计密码学算法。
7. **正式信令边界**：应用负责建立会话和交换连接信息，处理异步 ICE 候选及会话结束。开发探针的 SDP 文件交换、ADB 注入和候选静默等待仅用于验证，不作为正式连接协议。不能假定首次收集完成事件一定携带全部可用地址。
8. **局域网选路**：延续已验证的 Wi-Fi 路线，避免本阶段无须支持的蜂窝网络参与。Wi-Fi 失效按会话结束处理，不通过自动回退蜂窝实现后台继续控制。此约束不等于后续公网方案已确定。
9. **输入模块**：控制端提供触屏定位、英文、数字、符号以及 Enter、Tab、方向键、Ctrl+C。坐标解释与当前展示的显示器画面一致，缩放和留边须纳入映射。通过媒体基础设施的 DataChannel 回传输入，由被控端在授权会话内执行 Windows 输入操作；按下、释放、组合键及文本输入的具体消息格式在实现中定义。
10. **会话与并发模块**：同时只允许一个活动控制端，额外连接不得加入并混合控制。断网、退出和切后台结束会话，清理媒体和输入状态，释放会话持有的按键；重连建立新会话，旧会话遗留事件不得继续操作桌面。断线判定方式与时限属于实现参数，需要在测试中记录。
11. **统计与测量模块**：展示或在演示中提供实际帧率、码率和延迟测量结果，清楚说明采样窗口与统计位置。画面显示延迟的起点是被控端画面变化，终点是控制端实际显示；操作反馈延迟的起点是控制端输入，终点是对应反馈实际显示。RTT、解码耗时或消息回显时间不能直接命名为这两个指标。
12. **当前软件测量边界**：Windows 本地采集、帧处理、媒体提交使用同机单调时钟；提交不等于编码完成。操作到反馈帧耗时从控制端发送带唯一编号的操作开始，到控制端软件观察到真实桌面对应视频反馈帧为止，使用同一控制端单调时钟。反馈帧关联和实际结束位置须先验证并记录；不预设渲染提交或物理呈现可观测，不把 DataChannel 回显、Windows 日志或无关帧当作反馈。记录样本规则、失败/超时、统计关联、工具开销及未覆盖阶段；若关联不可行，记录阻塞，不降级冒充。上述指标不是物理画面显示延迟或操作反馈延迟。
13. **测量可信度**：跨设备时间戳相减必须有明确时钟对齐方案和误差说明；也可采用能够直接观察起终点的测量方法。尚未选择测量工具或绝对延迟阈值，不把未经验证的估算显示为精确端到端延迟。
14. **开发与证据流程**：沿用 SSH/SFTP、两端构建脚本、真机部署和独立运行日志。保存源码版本、构建参数、设备环境、场景、实验参数、结果摘要及失败证据；凭据、SDP 和本机私有连接配置不进入公开验证摘要。
15. **性能工作顺序**：先建立真实桌面的正常局域网基线，再分别做带宽、时延、丢包实验；据此选择一个主要瓶颈并完成优化前后对照。延迟阈值、弱网参数和具体优化方案后置确定，是此前确认的工作顺序，不是当前已完成的设计或结果。

## Testing Decisions

**主要测试边界只有一个：Android 真机与 Windows 被控端之间，通过应用正常入口建立的完整远程桌面会话。** 用户已确认此边界。优先从输入、可见画面、会话状态和实际远端行为判断正确性，避免把内部方法调用次数、队列实现或库的私有状态当作功能验收。

沿用现有联调脚本的启动编排、独立运行目录、退出码检查和日志回收方式。当前脚本的合成视频首帧与消息回显断言保留为快速连通性检查；产品验收增加真实桌面和真实输入结果，不把 echo 成功当作键盘输入成功。桌面采集单帧探针作为环境诊断辅助，也不替代整条会话验收。

| 场景 | 驱动方式与外部通过条件 | 证据及限制 |
| --- | --- | --- |
| 配对成功 | 从 Windows 交互桌面启动，手机通过地址和正确口令连接；实际显示该电脑桌面且可操作 | 正常应用入口完成，ADB/SSH 仅辅助部署与观测 |
| 配对失败 | 使用错误口令尝试连接；显示失败，无法看到桌面，也无法使 Windows 执行输入 | 同时观察控制端结果和被控端实际行为；日志中不记录明文口令 |
| 单连接限制 | 保持一个授权会话，再发起第二个连接尝试；不得产生两个活动控制者 | 可使用测试驱动模拟第二个请求，无须增加一部实体手机作为项目资源前提 |
| 实际画面 | 在被控显示器制造可辨认变化；手机能显示相应变化，桌面中的终端文本可用于操作 | 实际显示证据配合接收统计；收到数据包或解码回调不等同于屏幕已显示 |
| 定位与字符 | 手机触屏选择终端并输入已知英文、数字、符号序列；Windows 收到预期内容，手机看到相同反馈 | 覆盖展示缩放、留边下的有效画面定位；使用测试工作目录和可清理内容 |
| 终端按键 | 分别执行 Enter、Tab、方向键及 Ctrl+C 的可预测终端场景 | 验证执行、补全、编辑或历史、终止进程的结果；不只检查消息已发送 |
| 生命周期 | 分别触发断网、退出和切后台；原会话结束、按键释放，恢复后可手动建立新会话 | 包含组合键或按键按下期间中断，验证没有卡住的修饰键和旧会话输入 |
| 正常网络长测 | 在已说明的正常局域网条件下连续操作真实桌面 10 分钟，以 720p30 为目标 | 记录实际分辨率、帧率、码率、卡顿、异常和会话是否持续；30 秒合成图案测试不能替代 |
| 软件耗时测量（当前） | 正常授权真实桌面会话中测量 Windows 本地阶段，以及控制端发送操作到观察到唯一对应反馈视频帧的耗时 | 同机单调时钟，验证帧关联，保存原始样本、失败/超时、统计关联、工具开销和未覆盖阶段；不是物理显示延迟 |
| 物理延迟测量（延期、未验收） | 分别触发 Windows 画面变化和 Android 输入，观察各自直到手机实际显示的时间 | 保留原定义；后续有条件再验证方法和误差，软件结果不替代 |
| 独立弱网实验 | 分别限制带宽、增加时延、引入丢包；记录流畅度、操作到反馈帧耗时和解除限制后的表现 | 说明限制方向、参数、持续时间、实际网络条件和是否需要手动重连；一次实验只改变其目标因素 |
| 优化对照 | 同设备、同场景、同实验参数比较选定瓶颈的改动前后版本 | 保存原始结果及版本，说明改善、代价和未改善项，避免挑选单次最好数据 |

测试覆盖连接与配对、桌面视频、输入、会话生命周期、统计与测量模块在完整会话中的协同行为。若后续具体缺陷无法通过此边界可靠定位，再补充能够重现真实缺陷的局部测试；本规格不预先铺设一套与实现逐项对应的单元测试。

自动化覆盖可由脚本驱动并可靠观测的行为；设备授权、真实屏幕显示和端到端延迟等需要人工或外部观测的项目，记录明确操作和证据。不同性质的证据分别报告，不能仅凭应用自报“成功”就通过显示或输入验收。

当前阶段验收须覆盖上述功能场景、正常网络长测、软件处理耗时与操作到反馈帧耗时、三类独立弱网实验及一项优化对照，并明确列出物理延迟延期缺口。原完整验收仍须补齐两个物理延迟定义的测量；阶段完成不等于原完整验收通过。720p30 是否可稳定达到、延迟是否满足后续确定的阈值应据实判定；不达标时记录偏差和剩余工作，不能用当前 `ready-for-agent` 状态代替验收。

## Out of Scope

- 本版不实现公网访问、服务器中转、外网穿透或跨运营商场景；尚不满足“外出后连接家里电脑”的完整远期目标。
- 不传输音频，不扩展到 iOS、macOS 或 Linux 被控端。
- 不处理 Windows 登录界面、锁屏控制、UAC 安全桌面、开机自启、无人值守启动或休眠唤醒。
- 不支持多显示器选择与切换、多部手机同时控制。
- 不实现账户系统、设备发现、文件传输、剪贴板同步。
- 不实现中文输入法；复杂鼠标手势、额外快捷键或完整桌面输入兼容性不作为首版承诺。
- 不实现控制端后台保活、自动重连或无缝网络切换。
- 不自行实现编解码器、密码学算法或完整拥塞控制，不直接改造已有完整远程桌面产品。
- 不承诺硬件编解码已可用、某个未经测量的延迟数字、所有 Android/Windows 设备兼容或商用产品级能力。

## Further Notes

### 当前事实与未完成工作

- 已有 Git 基线为 `b916443`，包括代码、文档、技能配置与不含 SDP 凭据的验证摘要。
- Windows 交互桌面探针成功采集过 2560×1440 输出的一帧；这与视频传输探针是两个独立验证，不代表真实桌面已经通过媒体链路发送。
- 同一固定 WebRTC 版本的 Windows C++ 发送端和 Android arm64 接收端已构建成功。最终探针两次独立会话各运行约 30 秒，均显示 640×360 合成视频并完成 DataChannel 回显；接收解码实现为 libvpx。
- 两轮最后采样分别为 31 FPS、29 FPS；第二轮记录 packetsLost=13、freezeCount=1。不能声称零卡顿、完成 720p30 长测，或已测得端到端延迟。
- 实际桌面串接、真实输入、产品信令与配对、完整会话处理、性能测量与优化对照仍是待实现工作。

### 后续设计与测量决策

| 待定项 | 决定依据与完成时机 |
| --- | --- |
| 配对、认证、信令保护及身份绑定 | 实现连接模块时选择成熟机制并记录设计；正式联调必须覆盖正确与错误口令，不能跳过授权边界 |
| 输入消息格式、坐标和键状态语义 | 实现输入模块时明确；以终端结果和断线按键释放测试验证 |
| 编码器、码率参数与硬件加速 | 真实设备与真实桌面基线；不能由合成图案短测推定 |
| 队列策略与主要优化瓶颈 | 基线观测之后选定，再开展可比较的优化实验 |
| 画面显示与操作反馈延迟的方法及阈值 | 先选择能够测到完整路径的方法，说明误差，取得基线后记录目标；不凭空填入数字 |
| 弱网参数、持续时间及恢复判定 | 正常网络基线之后确定，实验之前记录并固定，优化对照保持一致 |

项目时间预算保持为约一个月、每天 4–5 小时；现有讨论未给出需在此补造的具体日历截止日。实现中出现 ADR 冲突时应明确指出并记录决策，不能默默扩大功能范围或替换技术路线。

参考记录：

- [领域术语](../../CONTEXT.md)
- [访谈与已确认范围](../../docs/design/project-brief.md)
- [局域网首版边界](../../docs/adr/0001-lan-video-first.md)
- [核心流程与基础设施复用边界](../../docs/adr/0002-own-video-pipeline-orchestration.md)
- [原生 libwebrtc 路线验证决定](../../docs/adr/0003-validate-native-libwebrtc-first.md)
- [第一阶段验证记录](../../docs/validation/phase-one-status.md)
- [结构化互通证据](../../docs/validation/evidence/interop-smoke.json)
- [现有探针复现说明](../../docs/guides/webrtc-probes.md)

较早访谈记录中保留了当时尚待核查的环境事项；当前完成状态以第一阶段验证记录及相应证据为准。
