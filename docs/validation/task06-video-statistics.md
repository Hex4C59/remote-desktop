# 任务06：可核对的视频统计

本任务仅增加会话统计及可信度验证，不构成任务08十分钟正常局域网基线，不测量任务07的两种端到端延迟，也不替代任务09独立弱网实验。沿用任务03—05的真机正常配对、真实 Windows 桌面和专用终端验收边界。

## 版本与环境

开始时 HEAD / Standards、Spec 审查基点：`811d2b30143351c1723c767a94cec9c383e2c10b`，工作区干净。实现位于本记录所在提交；构建源码逐文件哈希、产物哈希和原始证据索引见 [结构化证据](evidence/task06-video-statistics.json)。

设备为华为 MatePad Pro（MRO-W00），HarmonyOS 6.1，通过卓易通 1.0.10.34 运行现有 Android APK。Windows `adb devices -l` 为空，HDC 3.2.0b 列出选定平板 USB Connected；所有操作显式指定私有 DeviceSerial，不选择列表首项或 UART 设备。实际截图为 2800×1840。HDC 可观测 HarmonyOS 信息、兼容层可访问界面树和截图，但不能独立确认 Android API、Android PID、Activity 实例/生命周期回调或 Android logcat。Harmony API 24 不写成 Android API 24。

两次测试前的 Windows 控制台检查均为会话1 Active、未发现 LogonUI；输入动作另外检查专用终端前台和目标窗口，使用独立控制台输出与物理光标/按键状态判断结果。本轮实际 Windows 桌面为 2560×1440，接收视频 1280×720；不沿用任务05旧尺寸作为本轮测量。终端为 Windows PowerShell 5.1、PSReadLine 2.4.5、Consolas 32。

## 统计定义与固定库依据

WebRTC 固定提交为 `a3553f1c82a5580c91ad1f82baab4b11ed4b34b6`。通过固定源码核对字段，而非根据浏览器新版字段表推定 Android SDK 可用性：

- [RTCStatsCollector](https://webrtc.googlesource.com/src/+/a3553f1c82a5580c91ad1f82baab4b11ed4b34b6/pc/rtc_stats_collector.cc)：`bytesReceived` 来自接收 RTP payload 字节；`headerBytesReceived` 单独记录 RTP header/padding；视频 `framesPerSecond` 来自库的解码速率，只有大于零时才设置。`totalDecodeTime` 单位为秒。
- [MediaConfig](https://webrtc.googlesource.com/src/+/a3553f1c82a5580c91ad1f82baab4b11ed4b34b6/media/base/media_config.h) 默认 `stats_timestamp_with_environment_clock=true`；本项目没有覆盖。采集器使用环境单调时钟，`RealTimeClock` 使用 `TimeMicros()`，Java `RTCStats.getTimestampUs()` 单位为微秒。本轮原始时间值也与单调运行时间一致；不能当 UTC 时间或与 Windows 时钟直接相减。
- [ReceiveStatisticsProxy](https://webrtc.googlesource.com/src/+/a3553f1c82a5580c91ad1f82baab4b11ed4b34b6/video/receive_statistics_proxy.cc) 和 [VideoQualityObserver](https://webrtc.googlesource.com/src/+/a3553f1c82a5580c91ad1f82baab4b11ed4b34b6/video/video_quality_observer2.cc)：冻结来自库的帧间隔观察。虽然入口名为 `OnRenderedFrame`，这个版本使用帧元数据的 `decode_timestamp`，并不是物理屏幕呈现时刻。至少5个间隔样本后，以 `max(3×平均间隔, 平均间隔+150ms)` 判定；在后续帧到达时累计，暂停另计。因此当前画面停住时冻结数尚未增加，并不证明没有停滞。
- [W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/) 作为概念参考；实际字段存在性及本次含义以以上固定原生实现和原始样本为准。

采样位置为 Android 接收端 `PeerConnection.getStats()`，只接受恰好一个 `kind=video` 的 `inbound-rtp` 对象。每次回调处理完成后延迟1000ms再请求；因此不是宣称精确的一秒窗口。仅有一个在途请求，不积累无法返回的采样任务。

| 记录 / 界面 | 来源、单位及算法 | 局限 |
| --- | --- | --- |
| `window_ms` / 窗口 | 同一统计对象相邻 `timestamp_us` 差 ÷1000 | 实际采样窗口，包含调度变化 |
| `decoded_fps` / 解码 fps | `ΔframesDecoded ×1000 / window_ms`，项目派生 | 不是接收完整帧速率、渲染提交速率或物理屏幕 FPS |
| `received_payload_kbps` / 接收负载 kb/s | `ΔbytesReceived ×8 / window_ms`，十进制 kb/s，项目派生 | 含库所计重传负载，排除另计的 header/padding；不是网卡总流量或编码器目标 |
| `mean_decode_ms` | `ΔtotalDecodeTime ×1000 / ΔframesDecoded`，项目派生 | 没有新解码帧或字段缺失时 null；不是端到端延迟 |
| `framesReceived/Decoded/Dropped`、`keyFramesDecoded` | 基础库累计计数，原样保存 | 接收、解码、丢弃不能互换；不声称测到应用 renderer 提交或物理显示 |
| `framesPerSecond` | 基础库滚动解码速率，原样保存 | 与项目差分窗口不同；库在零速率时可能省略，不能补零 |
| `freezeCount/totalFreezesDuration`、`pauseCount/totalPausesDuration` | 基础库累计次数/秒 | 回顾性指标，见上文；冻结计数为零不等于当前画面正常 |
| `packetsReceived/packetsLost`、`jitter` | 基础库累计 RTP 包计数、秒 | 丢包可能为有符号值，原样保留；没有把累计计数伪装成本窗丢包率 |
| `frameWidth/frameHeight` | 基础库解码视频尺寸 | 实际接收视频分辨率，不是 Windows 桌面或平板物理像素尺寸 |
| `decoderImplementation/powerEfficientDecoder/codecMimeType` | 基础库解码器/能力标记及 codec 关联对象 | 字段缺失为 null，不推定硬件解码 |
| sender metadata | 目标上限30fps、4,000,000bit/s | 仅目标配置，不能作为测量值；短窗解码速率可超过30 |

原始字段采用白名单保存，缺失为 JSON null。首样本建立基线，速率显示 `—`；流标识由对象 ID、SSRC、codecId 组成，切换后重新建立基线。累计字节、帧数下降，或可用的接收帧/冻结/解码累计下降，均重新建立基线。非有限数、负值、非整数或超出 double 精确整数范围的必需计数不用于差分。

时间窗口必须大于0且不超过3000ms，并与 Android `SystemClock.elapsedRealtimeNanos()` 的实际观测间隔相符（差异不超过 max(250ms, 观测间隔25%)）。异常窗口不计算速率；下一有效窗口重新开始。两种时钟只比较间隔，不比较时间原点。Windows `steady_clock` 的接收经过时间仅用于日志排序；文件名的系统时间也不用于速率或端到端延迟。

## 界面、记录与结束语义

统计是桌面上方的独立文字区，显示短会话 UUID、样本编号、解码帧率、接收负载码率、窗口、分辨率、库冻结累计和丢包累计。软键盘占用空间时与状态栏一起收起，保留草稿、发送按钮和桌面可操作空间，隐藏不代表停止采样。

- 初始未配对/首样本分别显示暂无样本/等待采样窗口，不填零。
- 真实窗口内 `ΔframesDecoded=0` 时显示“本窗无新解码帧”；零是有效差分结果，但不据此断言网络坏了。静态桌面内容不变、没有新解码帧、库冻结事件是三个不同概念。当前 DesktopSource 在 DXGI 没有新纹理时继续提交缓存图像，因此内容不变仍可持续收到和解码帧。
- 独立 UI 定时器每1000ms检查新鲜度。最后回调处理时间超过3000ms，显示“采样已过期（非实时）”；这是阈值加 UI 调度的观察语义，不宣称硬实时三秒。超过3000ms才处理的回调不刷新实时值。
- 结束时停止采样与新鲜度回调，旧异步回调均受 `stopping` 保护；界面只保留“会话已结束（非实时）”及最后样本/确认编号。正常手动重连重建 Activity 和统计实例，使用新 UUID 与初始计数；不自动重连或后台保活。

Windows 经已授权 DataChannel 接收 `stats:1:` 遥测，与输入协议分开。每个正常配对发送端实例在**进程工作目录**创建 `receiver-statistics-<微秒标记>.jsonl`，路径写入 stdout `statistics_file=`。本次测试工作目录为各自私有 run 目录；正常使用可以直接回收该文件。每条包含完整 UUID、seq、原始计数/时间、派生结果、当时 UI 原文和 Windows 接收经过时间。每次写入并 flush 后返回 receipt，界面“电脑已存 #N”确认到该编号；flush 不声称断电后磁盘持久性。

日志限制单条8KiB、累计约16MiB、接收间隔至少200ms，并拒绝不同 UUID、重复/逆序 seq、错误 schema 和畸形 JSON。发送侧只有 DataChannel 无积压时才尝试遥测，不将成功排队当作已保存。日志记录 `missing_sequences_before`；它明确只包含**送达 Windows 的样本**，断网未送达样本不能凭空恢复。记录不可写/达到上限/未确认时，界面保留旧确认编号并标注当前样本未确认；不默默声称全部保存。结束记录 `receiver_end_observed=false`，不将发送端结束时间伪造为 Android 结束回调时间。

截图与 HDC 布局树分先后采集，非原子快照，本轮可相差1—2个采样编号。实拍 PNG 中可见编号和布局 JSON 中编号分别查询同一个 UUID 的 JSONL，不能强行将不同编号数值说成相同瞬间。

## 验收过程与失败记录

旧任务05 APK/发送端通过正常入口建立真实桌面并触摸聚焦专用终端后，统计断言失败：界面和可回收样本不存在。私有 run `ac8c13c033324be6b64ecce73c7f259b`。断言先于新版部署执行，但首版源码与 Android 编译已完成；这是旧产品红/新产品绿的验收对照，不伪称严格逐行先测后写。

首轮新版 run `de3487f71458426aa4172b00a1e7666c` 已取得终端空闲/动态实拍、JSONL 和界面关联记录。文件名中的 `static` 只代表专用终端当时没有输出；背景仍有其他应用，不能据此宣称全桌面像素完全静止。动态命令每150ms输出一个可辨认 `TASK06_FRAME_N`，独立 Windows 输出确认执行。随后旧终端断言因动态步骤已向 result-lines 写入完成标记而失败；已将“必须为空”修为“发送前后结果不变”，不能将此失败计作产品输入提前执行。

第二轮完整回归 run `8a78841937db46d7b55789cc4f96102f` 通过错误口令拒绝、正常配对、两点物理光标、两侧留白拒绝、拖动拒绝、95字符精确输出与 Tab 补全。随后前台窗口从专用终端切到浏览器视频，前台保护在发送前失败，停止测试；这不是产品统计失败，也不是完整回归通过。该轮回收124条样本、123个相邻有效窗口；截至此阶段与首轮新版合计194条样本、192个窗口，独立重算全部一致。两次异常中止通过测试清理强制停止发送端，因此缺少正常 `sender_stopped` 记录，不能伪装成会话正常结束。

用户随后确认可保留测试桌面继续完整验收。第三轮 `7c69360cb2c04923990ee911bdfaf94d` 又发生前台保护失败，截图显示 QQ 窗口出现在终端后方；未判定为产品自动抢前台。私有测试驱动随后只在专用终端真实可见、目标未遮挡时通过平板重新点击终端，核验前台后才输入，最多3次恢复；失败仍停止，不关闭用户其他应用。

第四轮 `1393984bb0b24bbc885d99f656780e66` 的独立物理光标为951,732，预期957,732，保留失败而未放宽1像素容差。该轮发送端记录的目标为957,732，不能将该自报目标代替实际命中。统计动态步骤曾插入首次触摸和回归断言之间，已将触摸回归移回触摸后立即执行；后续完整运行继续检验。该轮实际 DPI 为96，高 DPI 需独立补测，不能继承任务05结果充数。

## 完成的验收覆盖

验收由同一产品源码/二进制的多次**正常配对完整桌面会话**共同覆盖，不把外部前台干扰中止的整轮标成通过：

| 运行 | 已验证内容 | 整轮结果 |
| --- | --- | --- |
| `796ecff70e6844d3937d61a05f774160` | 错误口令拒绝、正常配对、触摸与留白/拖动、ASCII95、Enter/Tab/方向/Backspace/历史、真实前台子进程 Ctrl+C、软键盘避让、Home 结束、单控制端 busy、真实链路中断、未执行旧排队输入、恢复后不自动重连、手动新会话与 AFTER_NETWORK 实际输出 | 后续显式退出步骤前 explorer 取得前台，恢复点击未通过保护，整轮仍记失败；已完成的独立证据保留 |
| `403a25336ed54d99aa8d56b805f2aa65` | 120 DPI/125% 下两点物理定位、两侧留白/拖动拒绝、鼠标释放、受控静止终端区域、动态输出、ASCII95、显式结束、旧草稿和旧界面无效、Back 结束及分别手动重连、新会话桌面与 AFTER_EXIT/AFTER_BACK 实际输出 | 补测驱动退出0；`high_dpi_verified=true`，保留 `mode=text_only` 与 `full_behavior_assertions_passed=false`，不冒称它单独跑过此前所有全量步骤 |

高 DPI 窗口和系统均由 Win32 API 读到120 DPI，物理桌面仍为2560×1440。两点期望/实际分别为881,746与1722,520，均逐轴1像素容差内；原96 DPI运行的957,732与1586,578也匹配。没有将发送端自报坐标替代实际 `GetPhysicalCursorPos`。鼠标/终端键使用 `GetAsyncKeyState` 检查释放；本任务未重复任务05的部分 DOWN 注入诊断，不宣称独立捕获了正常点击的每个 DOWN/UP 瞬间。

静止实验让专用终端大部覆盖桌面、隐藏控制台光标，保持 `TASK06_STATIC` 10秒；实际截图边缘仍能看到少量其他窗口，因此只声称**受控终端区域静止**，不声称整个桌面逐像素恒定。动态实验由实际终端每150ms打印 `TASK06_FRAME_N`。两者都可持续解码，符合当前发送端对静止图像重复提交缓存帧的行为。它们不等同“本窗无新解码帧”。

可人工复核的同会话例子（实际 PNG 与 JSONL 中同编号分别核对）：

| 私有截图文件 / 会话前缀 | PNG可见样本 | PNG数值 / 独立证据 |
| --- | --- | --- |
| `statistics-controlled-static-a.png` / `da613483` | #58 | 31.6解码fps、623.2kb/s、1011.6ms；终端显示 TASK06_STATIC；JSONL #58完全对应。其稍后布局树为#60，不能拿#60数值比较PNG |
| `statistics-dynamic-b.png` / `da613483` | #90 | 36.1解码fps、200.2kb/s、1024.3ms；终端已有 TASK06_FRAME_30；JSONL #90对应。此短窗超过目标30不改写成30 |
| `network-input-queued.png` / `604d965c` | #36 | 本窗无新解码帧、0.0fps、0.0kb/s、1012.4ms、库冻结累计8；电脑只确认#33，当前样本未确认 |
| `final-ended.png` / 最后手动会话 | 最后#23 / 已存#23 | 会话已结束（非实时），桌面隐藏、输入禁用、重新连接入口可见，不再显示“输入已发送” |

10个已回收统计会话共748个 receiver samples，包含10个基线和738个正常窗口；独立重算738个窗口的帧率、码率及可用的平均解码耗时，全部与原始累计计数一致。有效窗口范围1001.857—1047.577ms。全部 JSONL 会话 UUID 不同，每次重新从基线 seq2开始（seq1在通道建立前未送达，以 missing_sequences_before=1体现）。明确区分5个正常结束日志和5个测试中止后强制清理、没有结束行的日志；不补造结束事件。

断网时的#36/#37确实未送达 Windows，JSONL最后为#33；只保留实拍/布局观察，**不伪造这些未送达样本的原始累计计数**。基础库冻结次数此时仍为8，说明累计冻结字段不是即时断流指示器。中断结束后旧会话不再写样本，正常手动新会话使用新文件、UUID、SSRC和基线；UI、回执和记录没有混用。源码的计数回退、同会话对象切换、异常窗口等防御分支经过双轴审查，不将未自然触发的分支写成已做真机故障注入。

## 断线条件与实际观测

统计新鲜度条件是单调观测时间超过3000ms，每1000ms检查一次；与信令20秒无完整帧期限、TCP/TLS操作期限和 WebRTC ICE/DataChannel 状态回调分开。ICE disconnected/failed、DataChannel closed、Wi-Fi丢失、Home/显式结束/Back 均沿用任务05的结束路径，不增加后台保活或重连重试。库 ICE 检测耗时不是项目承诺的固定三秒或二十秒。

双向 Any 协议阻断只匹配当前发送端程序及测试平板/热点双方地址，07:00前的该实验于 **06:56:02.1240338 UTC** 应用。独立截图文件在06:56:05.9230171 UTC写完（约+3.799秒）已显示无新解码帧和未确认样本；Windows日志最后写入06:56:07.3132829 UTC（约+5.189秒），记录 peer disconnected/closed 和 pairing_session_ended。驱动确认进程退出0后采集的结束页 PNG 在06:56:19.9173983 UTC写完（约+17.793秒）。文件写入时间是采证时间界限，不是精确回调/进程退出时刻；该轮后续前台保护中止，未持久化独立进程退出观测UTC，因此不补造精确退出延迟。

06:56:21.8231330 UTC主动恢复链路，60秒恢复兜底未触发，阻断规则剩余0。恢复后仍是非实时结束页，只有手动新配对才出现 AFTER_NETWORK 的真实 Windows 输出。显式结束的请求/进程退出观察为07:06:18.8229720/07:06:20.4866940 UTC；Back为07:07:19.6563092/07:07:22.9942335 UTC。这些间隔含 HDC 与观察开销，均不称为端到端延迟。

## 构建、审查与清理

Android APK SHA-256：`8d86511d54158a2b26697c4c561be56a5eff1b806d71464312efa6de41350d5c`。Windows sender SHA-256：`6a005eba5b4261874c09ef308631e8a515b39c7efd72f7fce0968901852453de`。两端构建和 GN 依赖检查通过；最终17个私有 PowerShell 驱动语法检查通过。14个 Windows 构建输入、5个 Android 构建输入逐文件与仓库源码哈希一致。APK经 MTP 核对14390472字节、正常安装界面明确成功；没有将 HDC 的安装界面证据写成独立 Android 包校验/API/PID证据。

Standards 与 Spec 以固定基点分别完成源码、最终文档及结构化证据复审：Standards 硬规范违规0、可行动 smell 0、未解决项0；Spec 未解决项0。最终 Standards 复审发现的“第二轮单次样本数与前两轮累计数”叙述歧义已修正为124/123与194/192，原始证据未变。两轴均独立核验工件/源码哈希与738个有效窗口，并复核实际截图；产品源码在构建和首轮审查后未变化。

Windows SSH曾重置，单次经本地代理重试恢复，后续直连正常；这是管理链路异常，不计入产品网络实验。热点启动还遇到 Success 后短暂 InTransition、初次无客户端自动关闭及 WLAN 列表翻页/已保存网络连接等待的问题，均留失败记录，不算产品配对失败。最终清理对实际热点配置、机器/用户/启动身份、零客户端重新核对；没有改写启动过渡态时留下的原记录。

Windows缩放已通过正常设置恢复100%；平板原 WLAN 通过实际设置界面确认连接，测试热点 Off，原持久配置和无客户端超时设置不变，两个热点会话均有清理收据。发送端、专用终端窗口、自建防火墙规则、HDC/显示设置计划任务均为0；平板600000ms测试超时覆盖不存在，电源回读 Timeout=30000ms、OverrideTimeout=10000ms，已因 TIMEOUT进入SLEEP。

原始截图、敏感日志、凭据及测试部署/证据文件保留在忽略目录；公开 JSON 只收录白名单统计、验证摘要与文件哈希。与任务04/05相同，**没有独立确认平板已保存的测试 WLAN 条目被删除**，不把热点关闭或原网络恢复当作删除证明。设备上的测试临时采证文件未逐项证明删除；它们作为证据保留，不属于活动进程/网络规则清理通过的范围。
