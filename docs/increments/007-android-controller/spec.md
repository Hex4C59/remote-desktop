# Android 控制端

status: draft

## 1. 范围

交付 [001 M1](../001-android-controls-windows-over-lan/spec.md) 的 Android 控制端。首轮使用 Android 10（API 29）及以上 ARM64 实体手机，用户在前台应用手动输入同一局域网内 Windows 被控端的地址。每次会话沿用现场配对、双向身份验证及 Windows 本机逐次授权。

先验收仅请求 `view` 的实时画面，再接入单指定位、点击和拖动，以及可打印 ASCII 文本、Enter、Esc、Ctrl+C 等基础键和组合键。键盘入口须支持文本提交、启动编译、运行程序和中断。首版限单显示器和前台控制。滚轮、多指手势、后台保持会话及 Android 被控端采集留待后续增量。

## 2. 接口约定

### 2.1 Android UI 与 C++ 组装边界

平台适配与 Java 工程位于 `src/platform/android/`。应用装配位于 `src/app/client/`。JNI 传递下列值，网络和会话状态由共用 C++ 组件处理。

| 类型 | 字段与作用域 |
| --- | --- |
| `AttemptId` | 控制端本地单调代次。每次启动分配，用于配对和待决授权。 |
| `SessionStamp` | `SessionId`、本地会话代次和 `negotiation`。会话建立后由 Session 下发。 |
| `SurfaceStamp` | `SessionStamp` 与本地表面代次。所有表面、呈现和坐标状态按该标记隔离。 |
| `InputStamp` | `SessionStamp` 和 `input_epoch`。指针事件另携带有效 `SurfaceStamp` 对应的 `display_map_version`。 |
| `ClientSnapshot` | 当前尝试、可选 `SessionStamp`、会话状态、实际授权、当前输入代次、首帧状态及可选的 001 错误。配对状态为不适用、等待输入口令、等待核对短码、等待提交或完成。仅等待核对期间提供本次尝试的短码。UI 只读。 |
| `SubmitResult` | `kQueued` 表示交给所属执行器。`kInvalidArgument` 表示参数或资源无效。`kStale` 表示作用域已失效。`kUnavailable` 表示当前状态无法接纳。可靠输入积压按 001 上报 `kInputQueueOverflow` 并关断。 |

| 入口 | 调用方与结果 |
| --- | --- |
| `start(address, permissions) → SubmitResult` | UI 主线程提交局域网地址与权限集合。非法地址格式或缺少 `view` 返回 `kInvalidArgument`，已有活动尝试返回 `kUnavailable`。Session 分配尝试代次，异步更新快照。 |
| `submit_pairing_code(attempt, code) → SubmitResult` | UI 在等待输入口令时提交本轮用户输入的配对口令。输入不合法返回 `kInvalidArgument`，旧尝试返回 `kStale`，当前阶段不接纳时返回 `kUnavailable`。提交内容只交给当前配对流程，处理后释放。 |
| `confirm_pairing(attempt, confirmed) → SubmitResult` | UI 在等待核对短码时提交现场确认或拒绝。旧尝试返回 `kStale`，当前阶段不接纳时返回 `kUnavailable`。配对在收到受保护的 `pair.complete` 且本地信任激活成功后显示完成。 |
| `stop(attempt) → SubmitResult` | UI 请求停止当前尝试或会话。经独立停止槽，重复请求合并，旧尝试返回 `kStale`。Session 异步回报关断及退出。 |
| `surface_available(stamp, surface, viewport) → SubmitResult` | UI 发布当前有效的 Surface 与物理像素尺寸。桥接层持有可异步交给 Decode 的引用。尺寸为零或 Surface 无效时拒绝，旧代次返回 `kStale`。 |
| `surface_lost(stamp) → SubmitResult` | UI 作废当前表面及待发输入，通过独立停止槽请求结束。旧表面返回 `kStale`，退出结果异步确认。 |
| `focus_changed(stamp, focused) → SubmitResult` | UI 失焦时立即停采集并清空待发输入。当前表面的焦点变化经独立状态槽交给 Session，旧表面返回 `kStale`。 |
| `activity_stopped(attempt) → SubmitResult` | UI 离开前台时通过独立停止槽取消待决尝试或结束当前会话，旧尝试返回 `kStale`，停止结果异步确认。 |
| `submit_input(stamp, event) → SubmitResult` | UI 在权限、焦点和当前代次满足时提交有界值类型。过期或不可用输入在 UI 和 Network 边界均被丢弃。 |
| `snapshot() → ClientSnapshot` | UI 读取 Session 发布的一致值快照。JNI 不跨调用借用字符串、事件对象或 Java 局部引用。 |
| `frame_rendered(stamp, presentation_time_us, render_time_ns)` | Decode 校验当前会话、协商和表面代次，有界投递首帧回执。Session 复核并发送一次 `session.ready`。 |

认证、会话请求和媒体必须属于同一已认证连接，批准前 UI 显示等待。认证失败、拒绝、超时、断线和显示映射变化沿 001 错误与关断契约处理。Android 不添加线缆消息。

### 2.2 解码、呈现与首帧

- Android 用系统 `MediaCodec` 解码 `h264-baseline` 到当前 `Surface`。检查 Android 解码器对 `media.offer` 协商能力的支持。不支持时通过 `media.answer` 拒绝。初始化或运行错误按 001 结束并上报。编码数据的访问单元及限额由媒体规格确定。
- UI 在会话开始之前可以持有平台 Surface。收到当前 `SessionStamp` 后，以新 `SurfaceStamp` 提交该有效表面。表面不可用时不能确认首帧。UI 管理表面、尺寸及呈现矩形，Decode 管理解码器与输出索引。应用层最多保留一个待提交输出，保留较新输出，较旧输出以不呈现的方式归还。提交给系统的输出遵守编解码器所有权约定。
- Decode 按表面代次注册 `OnFrameRenderedListener`。只有匹配当前 `SurfaceStamp` 的呈现回调才允许确认首帧。一次会话协商最多确认一次。仅出队、解码完成或释放输出索引均无首帧确认。无法得到有效回调时执行 001 首帧超时。回调时间与物理可见反馈分开记录。

### 2.3 触控、键盘与生命周期

- 按实际视频裁切区的宽高比在视口内等比居中。输入/媒体规格须把裁切区、Windows 单显示器物理像素域和 `display_map_version` 明确绑定。协商上限不充当物理坐标域。新手势落在黑边时忽略。已开始的拖动越界时夹紧，释放使用当前手势的最后位置。对矩形内坐标先计算 `[0,1]` 比例，再以 `floor(u * width)`、`floor(v * height)` 取得像素索引，上限分别夹为 `width - 1`、`height - 1`，按已绑定的原点换算成远端坐标。
- `mouse` 和 `keyboard` 各自校验实际授权、当前有效画面和 `input.enabled`。一次单指手势按顺序产生定位及按下、移动、释放。文本只在本地提交时发送，沿用 003 的可打印 ASCII 及单事件 256 字节上限，非法文本整项拒绝。Enter、Esc 和 Ctrl+C 使用可靠按键序列。
- 焦点丢失、触摸取消或视频矩形失效时立即停采集并作废待发输入，按协议对当前已准备或已启用代次发送 `input.pause`。收到 `input.suspended`、焦点和当前视频矩形恢复后才请求 `input.resume`。新代次收到 `input.enabled` 后才允许新输入。暂停无法可靠交付时走 001 关断路径。仅查看会话无输入握手。
- Activity 离开前台、当前 Surface 销毁或 Windows 显示映射变化时，作废旧画面和输入并结束本次会话。Decode 停止提交、归还缓冲、释放解码器和表面引用后确认退出。UI 在平台表面所有权允许的范围内保留其引用直至 Decode 回执，通过异步回执回收，不在 UI 等待。回前台或表面重建后由用户发起新的会话并重新取得 Windows 本机授权。迟到的旧回调不得确认新首帧或启用输入。

## 3. 不变量

- 未取得本机 `view` 批准时无媒体。`view` 专用会话无键鼠消息。普通输入同时满足权限、焦点、有效矩形及输入代次。
- 媒体、坐标映射、按压序列与资源回执均绑定当前作用域。旧会话、旧 Surface 或旧输入代次不得作用于新会话。
- 生命周期指令和首帧回执独立于媒体积压。日志只记录状态、序号、错误和统计，禁止记录配对口令、密钥、按键内容及画面。

## 4. 线程与资源

| 执行器 | 职责与上限 |
| --- | --- |
| Android 主线程（UI） | 前台、焦点、表面与输入采集。JNI 交接有界，不同步等待 Decode 或 Network。 |
| Decode | 持有一个编解码器及当前表面引用，应用待输出一项，首帧回执一槽。晚到回调按作用域丢弃。 |
| Network | 独占套接字、认证和收发。UI → Network 发往输入队列上限 32 条、500 ms，超限关闭会话。 |
| Session | 串行维护会话状态，消费首帧回执和焦点状态。停止及退出回执沿用 001 独立槽和代次校验。 |
| Writer | 异步写信任记录和统计。配对在途写入与统计上限沿用 001。 |

表面生命周期遵守 [线程模型](../../architecture/threading.md) 的当前代次与关闭优先规则。执行器跨会话复用。系统内部的图形和编解码线程按平台 API 所有权处理。

## 5. 验收场景

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| AN-01 | 短码错误、Windows 拒绝和仅 `view` 批准 | 短码错误不激活信任，拒绝前后无媒体，仅查看无键鼠发送。 |
| AN-02 | 交错旧 Surface 回调、当前输出索引释放及两个当前呈现回调 | 只在首个匹配呈现回调后发一次 `session.ready`。 |
| AN-03 | 不支持媒体参数、解码失败及缺少当前回调 | 分别拒绝媒体、按 001 关断以及触发首帧超时。 |
| AN-04 | 黑边起点、四角、带偏移裁切区及跨边界拖动 | 黑边无新事件，坐标有界，拖动释放完整并携带当前映射版本。 |
| AN-05 | 触摸取消、失焦、矩形失效及输入队列满或过期 | 输入立即作废，可靠暂停并用新代次恢复。达到 32 条或 500 ms 的上限后的超限路径按 001 关断。 |
| AN-06 | 离开前台或销毁 Surface，并延迟 Decode 退出 | 当前会话关闭，旧回调无效，缓冲和引用归还后确认退出，回前台须重新授权。 |
| AN-07 | Windows 改分辨率，旧输入仍在队列 | 旧映射不注入，Windows 完成清理后才开放新会话。 |
| ANH-01 | Android 真机连接 Windows 并获准仅查看 | 可见 Windows 真实桌面且 Windows 无普通注入调用。 |
| ANH-02 | Windows 批准鼠标和键盘，手机进行点击、拖动、文本和组合键操作 | 位置及键值准确，放手或结束后无残留按压。 |
| ANH-03 | 手机失焦、退后台、重建 Surface，Windows 锁屏、断链或改分辨率 | 按契约停止输入、清理按压及资源。作废的会话须重连授权。 |

Android 真机与 Windows 真机共同运行 001 M1H-01–06。按编号保存设备、构建标识、链路、时序及原始指标到 `test-results/m1/`。

## 6. 依赖与待决项

### 6.1 构建工具和测试依赖

Android 应用使用 Android SDK、Java 和 JNI，通过系统 `MediaCodec`（`video/avc`）向 `Surface` 解码。运行时由这些平台组件和获批的共用 C++ 组件构成。

| 项目 | 版本与配置 |
| --- | --- |
| JDK 和 Java | Eclipse Temurin `17.0.19+10`，Java 源码和字节码级别均为 17 |
| Android SDK | `compileSdk=36`、`targetSdk=36`、`minSdk=29`，Build Tools 固定为 `35.0.0`。本机 API 36 平台包为 revision 2 |
| APK ABI | 仅打包 `arm64-v8a` 原生库 |
| Android Gradle Plugin 和 Gradle | AGP `8.13.2`，Gradle Wrapper `8.13` 的 `bin` 发行版。建立工程时将[官方 SHA-256](https://services.gradle.org/distributions/gradle-8.13-bin.zip.sha256)写入 `distributionSha256Sum` |
| 原生构建 | NDK r28c `28.2.13676358`、Android SDK CMake `3.31.6`、Ninja、C++20。Gradle 显式设置 `ndkVersion` 与 `externalNativeBuild.cmake.version`，通过 JNI 装配共用组件 |
| 测试 | JVM 和设备端使用 `junit:junit:4.13.2`。设备端另用 `androidx.test:runner:1.7.0`，入口为 `androidx.test.runner.AndroidJUnitRunner`。共用 C++ 沿用 GoogleTest/GoogleMock `v1.18.0` 和根目录 Debug CTest |
| 设备工具 | Windows SDK Platform-Tools `37.0.0` 提供 `adb`，实测时记录 `adb version` |

JUnit 和 AndroidX Test Runner 是拟新增的测试依赖，仅进入测试配置，明确获准后才引入。共用传输所需的第三方依赖由对应功能规格提案和审批处理。依赖审批遵循[仓库约定 §3](../../../AGENTS.md#3-技术栈与工具链锁定)。

### 6.2 首台验收手机的准入条件

007 T001 核对用户指定的实体手机，记录型号、系统构建、API 和 ABI。要求 API ≥ 29，支持 `arm64-v8a`。用已知的 H.264 Baseline 1280×720、30 fps、Level 3.1 样片，验证至少一个系统 `MediaCodec` 能配置 AVC 解码、向真实 `Surface` 呈现可见画面，并收到与该表面匹配的 `OnFrameRenderedListener` 回调。记录解码器名称、软硬件属性、结果和失败点。

正式协商参数、媒体访问单元和性能按媒体规格与 M1 验收场景检查。预检失败时换用另一台符合条件的真机重测。若需改编码格式，先评审 001 和协议变更。

### 6.3 平台准备、仅查看与键鼠联调的前置条件

- **平台准备（007 T001–T003）。** 007 获批后，T001–T002 准备 Android 工程、JNI 和平台测试替身。T003 可用替身或本地样片验证界面、表面生命周期与解码行为。
- **仅查看联调（007 T004）。** 001 是会话总契约。001 T003–T004 的获批规格及实现提供共用 Session、双向认证、现场配对和 Windows 本机逐次授权。联调还需 003 的 Windows 原生采集，以及 001 T007 的获批媒体契约和可运行的编码链路。T007 定义 H.264 访问单元格式、编解码器配置数据、裁切元数据、协商和资源上限。001 T007 与 007 T004 共同交付同一个 `view` 检查点。
- **键鼠联调（007 T005）。** 先通过仅查看检查点。001 T005–T006 的获批输入与关断契约及实现提供输入许可、代次、暂停恢复和按压清理，并接入 003 的 Windows 注入和 005 的桌面状态。001 T007 与 T005 约定并测试视频裁切区、Windows 单显示器物理像素域与 `display_map_version` 的绑定。007 沿用 001 和现有协议的消息及作用域，坐标域以绑定的物理像素范围为准。

任务编号见 [001 任务清单](../001-android-controls-windows-over-lan/tasks.md)和 [007 任务清单](tasks.md)。

## 7. 并发自检

| 条目 | 约束与证据 |
| --- | --- |
| T-01、T-02 | UI、Decode、Network、Session、Writer 沿用职责，Surface 与首帧交接在 Android 线程映射中登记。 |
| T-03 | 一项应用待输出、一个首帧槽及独立停止和退出槽，输入 32 条、500 ms。 |
| T-04、T-05 | 复用有界缓冲和标记，平台分配单独测量，UI 与热路径不等待其他执行器。 |
| T-06 | 先关输入再停止提交，释放资源后才确认退出。 |
| T-07、T-08 | 实现标注线程归属并复用既有职责映射。 |
| T-09 | 记录手机系统呈现回执、物理可见反馈、帧率与覆盖率。 |
