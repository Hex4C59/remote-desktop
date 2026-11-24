# spec-android-screen-capture：Android 被控端画面采集

status: draft
approved-by: （待用户评审批准）

本规格定义 Android 被控端的首个交付目标。真机上发起一次有系统授权的屏幕共享，取得可验证的像素帧，并在停止后释放采集资源。

## 1. 范围

- 首轮验收目标为 Android 14（API 34）及以上的一台 ARM64 真机，由用户在系统对话框中选择共享整个屏幕。
- Java 平台模块提供本地「开始」「停止」和状态显示。首帧以尺寸和采集到的帧数确认，像素正确性用单独的测试画面验收。
- 本规格与 [M1 局域网纵向切片](../001-lan-vertical-slice/spec.md) 分别验收。视频编码、网络、音频、输入注入和远端渲染由后续规格定义。
- 首轮按单显示器、固定尺寸验收。采集期间发生宽高变化时结束本次采集，用户重新申请授权后可按新尺寸开始。

## 2. 接口契约

### 2.1 Android 平台内接口

拟在 `src/platform/android/` 的 Java 模块内定义。以下是 Android 主线程调用的控制接口。`requestStart()` 由当前可见的 Activity 响应用户操作后调用。控制器为系统对话框分配本地请求标识，结果回调带回启动该对话框时的标识。

```java
interface ScreenCaptureControl {
    void requestStart();
    void onConsentResult(long requestId, int resultCode, android.content.Intent data);
    void requestStop();
    CaptureSnapshot snapshot();
}

record CaptureSnapshot(CaptureState state, CaptureEndReason endReason,
                       int width, int height, long framesAcquired) {}

enum CaptureState { IDLE, AWAITING_CONSENT, STARTING, CAPTURING, STOPPING }

enum CaptureEndReason {
    NONE, USER_STOPPED, CONSENT_DENIED, SYSTEM_STOPPED,
    SIZE_CHANGED, START_FAILED, FRAME_READ_FAILED
}
```

- 初始状态为 `IDLE`、`NONE`，尺寸和帧数为零。`requestStart()` 仅在 `IDLE` 接受，清空上一轮统计后进入 `AWAITING_CONSENT`。其余状态下的开始请求忽略。等待授权时停止，回到 `IDLE / USER_STOPPED`，随后到达的旧结果失效。旧请求的结果靠请求标识区分，即便新一轮也处于 `AWAITING_CONSENT`。
- 系统拒绝、取消或返回空授权数据时回到 `IDLE / CONSENT_DENIED`。授权通过后进入 `STARTING`。前台服务以 `mediaProjection` 类型进入前台后才调用 `getMediaProjection()`。先注册 `MediaProjection.Callback`，再创建一次 `VirtualDisplay`。前台服务或投影链路创建失败时回收已创建资源，最终进入 `IDLE / START_FAILED`。
- `STARTING` 在首张有效帧通过格式和尺寸检查后进入 `CAPTURING`。`snapshot()` 返回同一采集代次的状态、结束原因和统计。开始前尺寸为零，结束后保留本轮总帧数和最后有效尺寸，供真机核验。
- Android 主线程先处理授权结果，随后由 Capture 执行器串行提交首帧、停止和错误事件。同一代次以首个提交的终止事件决定结束原因。提交终止事件后进入 `STOPPING`，帧计数冻结。本地停止对应 `USER_STOPPED`，系统撤销对应 `SYSTEM_STOPPED`，尺寸变化对应 `SIZE_CHANGED`，帧读取异常对应 `FRAME_READ_FAILED`。前台服务和采集资源清理完成后转回 `IDLE`。

### 2.2 采集数据

`MediaProjection → VirtualDisplay → ImageReader`。Capture 执行器调用 `acquireLatestImage()`，空结果表示当前无图可取。有效帧使用 Android `RGBA_8888`，读像素时按实际 `rowStride` 和 `pixelStride` 寻址，检查缓冲区范围。每次取得的 `Image` 在同一次回调内关闭，包含验证失败的情况。

Android 帧保留在平台内。当前 C++ [帧移交契约](../002-screen-frame-handoff/spec.md) 只定义 `kBGRA8`，后续接入编码链路时需先为 Android 的帧格式与所有权制定契约。

## 3. 不变量

1. 每个有效采集代次都有一次本地系统授权，最多消费一次授权结果并创建一个虚拟显示。新一轮重新申请授权。拒绝、取消或作废的结果不启动采集。
2. 投影服务不导出。系统可见的投影会话从前台服务建立后开始，到服务清理结束。服务重启不会自动恢复投影。系统屏蔽的内容保持屏蔽。
3. 同一时间至多一个活动投影。`ImageReader` 的 `maxImages = 2` 是同时可获取图像的上限，应用最多在回调内持有一张返回的图像。应用侧帧队列容量为零。
4. 已进入 `STOPPING` 或属于旧代次的回调不能推进状态或计入帧数。图像回调和采集资源的释放串行执行。
5. 像素和授权数据不写入文件、日志或网络。统计只包含状态、尺寸、计数和耗时。

## 4. 线程与资源

| 所属执行器 | 责任 | 资源与上限 |
| --- | --- | --- |
| Android 主线程 | Activity 授权交互、前台服务启停和本地状态读取 | 只容许一次活动授权请求。开始和停止按状态合并，不等待 Capture 执行器 |
| Capture | 串行处理投影、虚拟显示、图像回调与回收 | 进程内一个专用 `HandlerThread`，反复采集复用。一次投影、一个 `VirtualDisplay`、一个 `ImageReader`。通过 `acquireLatestImage()` 丢弃旧图 |

- 主线程将启动及停止命令异步交给 Capture。每代最多挂起一个启动命令和一个停止命令，携带代次标识。Capture 从一份预分配的、有界的共享记录发布状态和统计。主线程主动读取同一代次的一致快照。
- 停止时 Capture 禁用图像回调，完成当前回调并关闭其中的图像，再释放 `VirtualDisplay`、关闭 `ImageReader`、注销投影回调、停止仍活动的投影，最后通知主线程撤下前台服务。清理中到达的旧回调失效。
- 图像回调只做取帧、验证及定长统计，应用层不创建逐帧副本或对象，不编码、不写盘、不等待其他线程。SDK 取帧与读平面产生的开销在真机单独测量。

## 5. 验收场景

### 5.1 自动化

使用替身测试授权、平台调用顺序和资源释放，以合成像素缓冲测试像素读取。用例编号随测试结果记录。

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| AC-01 | 拒绝、取消、空结果或等待授权时主动停止 | 创建投影及虚拟显示的调用数为零 |
| AC-02 | 连点开始或投递上一代授权结果 | 只对有效代次消费一次授权，创建一次虚拟显示 |
| AC-03 | 授权成功并启动 | 调用顺序为前台服务、获取投影、注册回调、创建虚拟显示 |
| AC-04 | 首帧有效，缓冲有行尾填充 | 按实际步幅读取指定像素，进入 `CAPTURING`，帧数为 1 |
| AC-05 | 取帧为空，或图像读出后验证失败 | 空帧不计数。坏帧只释放一次，采集以 `FRAME_READ_FAILED` 结束 |
| AC-06 | 在启动各步骤注入失败 | 已创建的资源各释放一次，回到 `IDLE / START_FAILED` |
| AC-07 | 主动停止、系统停止、晚到图像回调交错 | 结束原因只记录一次，停止后的帧数不增长，资源各释放一次 |
| AC-08 | 采集内容宽高发生变化 | 以 `SIZE_CHANGED` 结束，原授权下不创建第二个虚拟显示 |

### 5.2 真机

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| ACH-01 | 在 Android 14+ ARM64 真机授予整屏共享权限，打开带大面积色块的测试画面 | 至少取得一张有效帧。测试读取指定区域像素，验证颜色、宽高和行步幅 |
| ACH-02 | 分别从应用停止、从系统界面结束共享、锁屏，然后重新授权 | 每次均回到 `IDLE`，原代次计数停止增长，新授权可正常取得首帧 |
| ACH-03 | 连续启动和停止 10 次，随后以动态测试画面持续采集 60 秒 | 每轮结束时应用持有的采集资源计数归零。持续采集期间帧数增长，无采集失败 |
| ACH-04 | 使用包含 `FLAG_SECURE` 区域的合成测试画面 | 探针读不到受保护区域绘制的已知测试颜色，同屏普通区域的测试颜色仍可读 |

记录机型、系统版本、屏幕尺寸、授权确认到首帧的耗时、60 秒取帧数和回调处理耗时 P50/P95。
证据放在 `test-results/android-capture/`，仅保留统计与验收结果。

## 6. 依赖与待决项

- 使用 Android SDK 的 `MediaProjection`、`VirtualDisplay` 和 `ImageReader`。采用 Java 及 Android Gradle 构建 APK，具体 SDK、JDK 和构建插件版本在实现前根据本机构建环境锁定。新增测试依赖按仓库规则评审。
- 审批本草案时需落实 Android 平台目录和构建约定，涉及 `AGENTS.md` 第 3 节、[架构总览](../../architecture/overview.md) 第 9、10 节、[平台抽象](../../architecture/platform-abstraction.md) 第 1、3 节。Android 端首轮 API 属于平台内控制边界，批准后再落地声明。
- 平台内的生命周期命令与状态读取涉及 [线程模型](../../architecture/threading.md) 第 1、2 节。该文档目前只允许其列出的线程职责及数据流，需先确认此处的 Android 映射与交接规则并同步更新。
- [Android MediaProjection](https://developer.android.com/media/grow/media-projection) · [ImageReader](https://developer.android.com/reference/android/media/ImageReader)

## 7. 并发自检

| 条目 | 约束与证据 |
| --- | --- |
| T-01 | 主线程负责授权与服务生命周期，专用执行器对应 Capture。职责映射待同步至线程文档 |
| T-02 | 主线程到 Capture 传递有界生命周期命令，Capture 到主线程提供状态快照。平台内交接须写入线程文档 |
| T-03 | 应用帧队列容量为零，`maxImages = 2`，每代启动和停止各至多一个挂起命令 |
| T-04 | 应用代码逐帧不新建对象、加锁、写盘或拼接日志。真机单独记录 SDK 调用开销 |
| T-05 | 主线程和 Capture 均不等待对方，停止完成用异步通知 |
| T-06 | 首阶段不启用输入。停止更新统计、关闭图像、释放资源，最后撤下前台服务 |
| T-07 | Activity 和服务标明 `// Thread: UI`，采集资源实现标明 `// Thread: Capture`，跨线程只读快照标明 `// Thread: any` |
| T-08 | 复用一个映射到 Capture 职责的执行器，Android 平台映射批准后落地 |
| T-09 | ACH-01 与 ACH-03 记录 Android 首次实测基线，供后续媒体链路对比 |
