# 软件耗时采集与反馈帧复核

当前方法支持普通桌面与终端操作。每次输入前写明预期视觉反馈，变化检测帮助定位候选，人工确认反馈边界。它不测量物理屏幕呈现；两类物理显示延迟仍延期、未验收。

## 计时与证据

Windows 通过 `sender --serve --software-trace <新目录>` 开启阶段日志，默认关闭。`software-stages-v1` 的 `capture_ns` 包含 `FrameSource::Capture` 整体调用；其内部依次观测 `AcquireNextFrame`、GPU 复制与 `Map`、ARGB→I420 转换、需要时的旋转、缩放。`submit_ns` 截止同步 `Push` 返回，`total_ns` 包含采集和提交，不含后台写日志，也不代表编码完成。单位是纳秒，数值为十进制字符串；未执行阶段为 `null`。

`fresh` 的源帧编号递增；`reused` 表示 `AcquireNextFrame` 等待超时后提交旧帧，`empty` 表示超时且尚无旧帧，`failed` 表示失败。复用帧保留旧编号，转换、旋转和缩放不适用。独立的 `acquire_status` 区分取得新帧、等待超时、失败和不适用。日志同时记录源尺寸、提交尺寸及最近成功保存的任务06统计序号；序号关联是近似窗口关联，不是跨机器时钟同步。后台写入队列最多128条，总文件预算32 MiB；丢失计数、写入失败和结束记录用于判断日志完整性。

Android 在授权、输入队列和缓冲量校验通过后、调用 `DataChannel.send` 前记录 `elapsedRealtimeNanos`；独立 `VideoSink.onFrame` 入口记录同机终点。测量按钮默认未开启，启用后只对明确准备的下一次操作采样，同一时刻最多一个操作，采样期间拒绝新输入。

每次操作保留前1秒和后5秒的完整解码 I420 图像（无损 zlib），不会在会话中回传图像。回调只取得入口时间、保留引用并交接，复制、压缩和保存由独立线程执行。最多两个项目持有的待处理帧引用（包括正在处理者），前序图像环32 MiB，每张图像最大4 MiB，项目临时图像缓冲与环合计低于64 MiB；解码器自身内存不计入此预算。超大图像、队列溢出、转换失败、保存失败及前序环淘汰都有缺口或失败记录。

## 先验证关联，再正式采样

1. 重新核对两端系统、设备标识、部署文件 SHA256、网络和 Windows 桌面状态。Windows 必须已登录、未锁定；HDC/ADB 必须显式选择本次可见的设备标识。连接配置和本机源码路径写入用户本地配置。
2. 正常配对，分别在普通窗口和终端验证指针点击、文本提交、Enter、Ctrl+C 的视觉反馈关联。通过测量按钮填写分类、完整反馈判据，准备后等至少1秒，再执行一次操作；等待5秒窗口结束再进行下一次输入。
3. 方法验证通过后固定四类可辨认操作，每类1次预热、5次正式尝试，正式共20次。记录预期反馈，保留所有尝试，包括发送失败、超时、不可判读、不完整、会话结束和未执行；不能删除失败后补齐成功数量。
4. 会话结束后回收控制端应用的 `externalFilesDir/software-measurement/<实验UUID>`。Android 原始证据目录由系统提供，按本次 HDC/ADB 设备实际路径回收，不假定卓易通映射位置。Windows 回收阶段日志和对应 `receiver-statistics-*.jsonl`；原始图像、地址、配对日志保留在 `.local/` 或 `build/`。
5. 生成离线页面（依赖已安装的 ffmpeg），逐帧查看完整证据，选择连续的“最后尚无完整反馈”和“最早完整反馈”两帧。变化候选不能替代逐帧判断。页面显示入口时间及相对输入时间，导出 JSON 才保存选择。复读全部正式边界，填写复读者；同人复读自动明确标注。

```sh
python3 scripts/latency/software.py review .local/run/experiment .local/run/review
# 用浏览器打开 .local/run/review/index.html，导出 software-review.json
python3 scripts/latency/software.py analyze .local/run/experiment .local/run/software-review.json .local/run/feedback.json
python3 scripts/latency/software.py stages .local/run/stages.jsonl .local/run/stages-analysis.json
```

输出包含所选帧观察耗时 `(反馈入口 − 发送前时间)`、相邻判读帧形成的区间、各状态数量、正式有效样本的中位数与范围。下界早于发送时刻时截为0；它不是屏幕显示时间或完整触摸链路延迟。反馈边界与缺口相交或尺寸/旋转变化时自动标为不完整。索引和所选原始帧 SHA256 绑定复核，旧会话标注不能用于新证据。

## 用户委托Agent复核的记录方式

默认页面输出 `software-review-v1`，按原人工流程使用。若用户明确将剩余视觉判读委托Agent，另用 `software-review-v2` 记录，CLI分析支持此版本；现有人工页面的导入仍仅接受v1。不得只给OCR候选补上复核者名称就视作完成，也不得把AI判读写成人工。

v2顶层增加 `authorization`：`mode=user_authorized_ai_visual`、`requested_by=user`、ISO日期 `date`、用户授权原话 `instruction`。每行必须填写 `reviewer_kind`／`rereviewer_kind`（human或ai）、复核与复读者、完整反馈判据和 `rereviewed=true`，包括失败／排除行。任一AI参与而没有该委托记录时拒绝分析；v1不能承载AI行。授权字段用于审计，不是身份认证或签名。一次复核范围的改变不自动改写既有原始协议，应公开说明本轮结项口径与原要求的区别。

实际阅读解码图像，先按时间顺序检查完整反馈，随后重读全部正式边界。结果保留复核来源、同一复核者标记及原始帧哈希；同一AI复读标为 `same_reviewer_rereview=true`、`same_person_rereview=false`。AI和人工数量分别报告，不能宣称独立复核。自动降为不完整的样本仍保留所选帧和两遍复核来源，但没有有效耗时。

原始日志formal还包含方法验证时，可在复核文件顶层用 `formal_scope` 明确列出预先固定的实验／会话／操作身份。分析验证这些身份存在且是formal，只将其计入正式统计；`raw_formal_attempts`和完整samples保留其余记录，不改写原phase，也不能事后删去失败尝试。未指定范围时沿用全部formal。

v2实例及本轮40次真实视觉复核见[授权复核记录](../validation/task07-authorized-visual-review.md)。结果同时保留十进制字符串整数差值 `observed_frame_latency_ns`／`interval_ns` 和便于阅读的毫秒数。较长相邻回调间隔应公开其区间宽度；没有保存缺口不能据此填出未收到的帧。

## 测量开销对照

同一设备、桌面负载、目标配置分别运行关闭和开启测量的120秒对照。关闭组不传 `--software-trace`、不启用 Android 测量；开启组开启两端观测，并按相同操作节奏采集图像。每组使用独立会话，明确记录所用任务06序号及控制端单调时钟窗口。

为每组保存 `measurement-overhead-run-v1` JSON，字段为 `session`、`clock: elapsedRealtimeNanos`、`start_ns`、`end_ns`（相差120000000000）、`measurement_enabled`（布尔值）、相同的 `workload_id` 和 `device_setup_id`。这些窗口是已观测控制端时间，不能填写墙钟或 Windows 时间。汇总程序按实际相交窗口加权，包含0 FPS冻结窗口，不把不可用样本补为有效值。

```sh
python3 scripts/latency/baseline.py overhead .local/off/statistics.jsonl .local/on/statistics.jsonl .local/off/window.json .local/on/window.json .local/on/feedback.json .local/overhead.json
```

对照报告包含解码帧率、接收负载码率、解码耗时变化、库冻结统计、复制/压缩/写入耗时及采样缺口。所有软件反馈耗时均来自开启测量的运行；开销对照未运行时，必须公开保留缺口。

## 构建与检查

固定依赖版本继续使用仓库清单。Android 首次构建使用 `scripts/linux/build-webrtc-probe.sh <本地固定源码目录> 4`。Windows 构建脚本同时编译 `sender` 与 `software_trace_smoke`；后者只验证有界日志写入和会话关联，不访问桌面，也不构成媒体运行证据。

```powershell
scripts\windows\check-software-trace.ps1 -WebRtcRoot <固定源码目录> -OutputDirectory <全新忽略目录>
```

```sh
python3 -m unittest discover -s scripts/latency -v
node scripts/latency/test-review-import.cjs
```

正常配对、错误口令、触屏与高DPI、终端按键、切后台、断网、结束和手动重连需要在当前产物上另做运行验证。构建成功不能代替这些检查。

新 checkout 若缺少 Siso 后端配置，构建脚本安装仓库的本地配置模板；已有配置保留。固定 Siso 使用 `-local_jobs` 控制并发，`-remote_jobs 0` 关闭远程编译。

## 会话结束后的文件导出

应用内点击“结束会话”，等待帧引用、图像写入与索引全部排空，再点击“导出测量证据”。使用系统文件保存入口，将实验目录连同索引、缺口、失败记录和关闭标记打包到本地下载目录。导出在后台串行执行，不占用视频或控制通道；显示“测量证据已导出”且重新连接按钮恢复可用后再复制文件。取消或写入失败保留原始实验，失败的目标文件可能不完整。

配对页面的“导出已保存测量证据”按实验 UUID 选择历史目录；标记“未完整关闭”的目录可以回收，但不因此获得完整采样状态。文件选择和后台导出分别恢复自己的实验身份，不能把旧操作移入新授权会话。会话关闭标记在写入完成后原子发布；后台仍拥有的实验不能同时导出。

卓易通的 Android 应用目录可能不通过 MTP 暴露。经系统文件保存入口导出到 Android 下载目录后才能回收。实测 Windows MTP 会缓存文件仍在写入时的大小，复制可能截断；等待导出完成后刷新对应设备的文件传输接口，再重新枚举并复制。接口身份须与本次选定的设备一致，不能重启全部 USB 设备。复制前后核对文件字节数和 SHA256，并用 ZIP CRC、关闭标记、全部索引和帧解压检查确认完整性；单凭成功提示或稳定大小不能验收。

前台输入检查失败时保留本次记录并停止发送。窗口位于最前层不等于持有键盘焦点；恢复专用测试窗口的实际前台状态后再开始新实验。


### 2026-10-13 实机复现补充

离线复核页面必须使用实际实验解包后的全量帧；演示页和AI候选都不计入人工有效样本。导入AI预选时仍保留unreadable、空复核者、未复读，逐样本人工确认后才能改为valid。原始phase不会因方法验证排除而改写，应在预先固定的类别协议下另列正式20次。

完整导出后先检查ZIP CRC、单实验／会话身份、索引和全部帧解压，再生成页面；大小或传输SHA一致不能替代CRC和帧有效性检查。导出失败或CRC错误时保留该份，使用同一已关闭实验重新导出到新文件，不能修补CRC或丢弃坏帧后宣称完整。本轮历史证据在相同签名更新后仍可导出；记录采集与导出各自APK哈希，更新必须在会话关闭、原始写入完成后执行。

ZIP输出使用64 KiB缓冲，图像原始数据仍在控制端，缓冲不进入帧回调或媒体／控制通道。导出用时仅描述各次观察，文件大小不同不能作为受控速度提升倍数。

## 导出与回收校验（2026-10-13）

会话结束且原始写入完成后，导出会同步文件、关闭目标并回读所有ZIP项的CRC，核对写入与回读的字节数及SHA-256。成功提示包含这两项回执；失败保留原始实验及目标文件。“校验已导出 ZIP”可只读检查历史文件，ZIPCRC失败与读取/缓存失败分别提示。校验需额外临时磁盘空间约等于ZIP大小；不在采样期间运行。

MTP回收内容可能与平板内读取不同。保存成功后再回收，确认复制结束，使用平板回执执行：

```sh
python3 scripts/latency/archive.py recovered.zip --bytes BYTES --sha256 SHA256
```

任一检查失败都保留副本，用同一已关闭实验导出到新文件；不得改CRC、丢坏帧或仅凭文件大小通过。回执和ZIPCRC通过后仍检查索引身份、全部帧解压，再生成全量复核页。具体调查范围和实机复验见[导出完整性记录](../validation/task07-export-integrity.md)。
