# spec-lan-vertical-slice：局域网远控纵向切片

status: draft
approved-by: （待批准）

里程碑级规格：描述 M1 的边界与整体验收，不直接授权单个功能的实现。
具体功能的契约在各自的功能级规格中，见 [规格目录](../README.md)。

本文是 M1 范围内范围的唯一事实来源。架构背景见 [架构总览](../../architecture/overview.md)，
线程与队列见 [线程模型](../../architecture/threading.md)，平台接口见
[平台抽象](../../architecture/platform-abstraction.md)。

## 1. 范围

M1 只做一件事：在同一局域网内，用控制端看到 Windows 真实桌面并操作鼠标和键盘，延迟可测。

包含：

- Windows 被控端运行在已登录、未锁屏的交互会话。
- 双方在同一局域网，直连，无控制面服务器、无中继。
- 现场配对一次，配对后即可发起会话。
- 单显示器、单视频轨道、单活动控制端。
- 采集 → 编码 → 传输 → 解码 → 渲染，以及输入反向链路。

不包含：

- 公网、NAT 穿透、TURN、中继、无人值守授权。
- 文件传输、音频、剪贴板、多显示器、自适应画质。
- macOS/Linux 被控端与被控平台支持声明。
- Android 控制端（见第 8 节待决项，需单独批准）。

## 2. 接口契约

### 2.1 会话状态

```cpp
enum class SessionState {
  kIdle, kRequesting, kAuthorizing, kNegotiating, kStreaming,
  kRejected, kEnding, kFailed
};

struct SessionLimits {         // 来自平台与会话配置
  uint32_t max_width, max_height, max_fps;
  uint32_t max_bitrate_bps;
  std::chrono::milliseconds input_queue_deadline;   // 默认 500 ms
  uint32_t input_queue_depth;                       // 默认 32
};
```

状态迁移与不变量见 [架构总览](../../architecture/overview.md) 6.2。
所有迁移由 Session 串行执行器完成，其他线程只投递事件。

### 2.2 错误码

| 错误 | 触发 | 处理 |
| --- | --- | --- |
| `kNotPaired` | 控制端未在本机信任名单 | 回 `pair.reject`，提示现场配对 |
| `kBadPassword` | 口令证明不匹配 | 计数 +1，达 3 次作废配对窗口 |
| `kCodeMismatch` | 短校验码不一致 | 不落盘信任，结束配对 |
| `kBusy` | 已有活动会话 | 拒绝，不解占当前会话 |
| `kUnsupportedCodec` | 控制端不接受 `media.offer` | 结束会话，`bye.reason=error` |
| `kSessionNotInteractive` | 锁屏/注销/安全桌面 | 结束会话并释放按压 |
| `kInputQueueOverflow` | 输入队列超限 | 结束会话并释放按压 |
| `kTransportClosed` | 传输层断开或保活超时 | 结束会话并释放按压 |

### 2.3 线程归属

严格遵循 [线程模型](../../architecture/threading.md) 第 1 节：Capture / Encode / Network /
Session / Input / Decode / UI 各一个，不新增线程。本规格不引入新的线程或线程池。

## 3. 不变量

1. **Capture 线程绝不阻塞在编码器上**：采集帧槽只有 1 帧，新帧覆盖未处理旧帧。
2. **输入不等待画面**：Input 执行器不等待编码、渲染或写盘；注入失败只上报告警。
3. **授权门禁先于注入**：不在 `kStreaming`、`input_epoch` 未确认或授权失效时注入任何事件。
4. **按压状态零残留**：进入 `kEnding`、`kFailed`、断线或锁屏时，本程序按下的所有键盘与
   鼠标按钮被释放，且释放动作本身不受输入队列上限限制。
5. **会话独占**：同一被控端同一时刻只有一个活动会话；`kAuthorizing` 期间也拒绝第二端。
6. **旧消息无效**：结束的会话的 `session`、旧 `negotiation`、旧 `seq`、旧 `input_epoch`
   消息一律丢弃，不得影响当前会话。
7. **队列有界**：热路径队列上限与溢出策略固定，溢出必须可观测并进入统计。
8. **无敏感信息入日志**：配对口令、会话密钥、屏幕内容、按键内容不进日志与 Git。

## 4. 验收场景

每条都须先有失败测试（[AGENTS.md §5](../../../AGENTS.md)）。测试用 mock 平台接口，
不依赖真实设备；真机验收单列。

### 4.1 单元/集成（可自动化）

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| M1U-01 | 未配对发起会话 | `kNotPaired`，不发 `session.challenge` |
| M1U-02 | 配对口令错误 3 次 | 第 3 次后窗口作废，后续请求 `kNotPaired` |
| M1U-03 | 短校验码不一致 | 信任名单未写入，返回 `kCodeMismatch` |
| M1U-04 | 配对成功后重放旧质询 | 被拒绝，不重复消费 |
| M1U-05 | 会话中第二控制端请求 | `kBusy`，原会话不受影响 |
| M1U-06 | 媒体协商拒绝 | 状态机进入 `kEnding`，不进入 `kStreaming` |
| M1U-07 | 未 `input.ready` 就注入 | 事件被丢弃或返回 `permission_denied`，不产生平台调用 |
| M1U-08 | 输入队列超 32 条 | 结束会话，统计记 `kInputQueueOverflow` |
| M1U-09 | 输入排队超 500 ms | 结束会话，旧事件不补发 |
| M1U-10 | 会话中切换锁屏 | 立即 `kEnding`，按压全部释放 |
| M1U-11 | 传输断开 | 立即 `kEnding`，不等待对端 `bye` |
| M1U-12 | 连续 50 次结束/重连 | 无资源增长，无残留按压 |
| M1U-13 | 旧会话 `media.answer` 到达新会话 | 静默丢弃，新会话状态不变 |
| M1U-14 | 帧槽积压（编码慢） | 采集帧被覆盖，不排队，延迟不累积 |
| M1U-15 | 控制消息 > 64 KiB | `malformed_envelope` 并关闭连接 |

### 4.2 真机验收

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| M1H-01 | 同一对机器连续 10 次会话 | 全部成功，每次都能看到真实桌面 |
| M1H-02 | 鼠标与键盘操作 | 位置准确、按键无错乱、无残留按下 |
| M1H-03 | 结束会话 / 拔网线 / 锁屏 | 输入立即停止，按压释放，可重新连接 |
| M1H-04 | 局域网延迟测量 | 满足 [架构总览](../../architecture/overview.md) 8.3 的预算与覆盖率要求 |
| M1H-05 | 1 小时会话 | 无崩溃、无按键残留、关闭后资源回收 |

M1H-04 必须给出完整采集条件与原始数据路径；未跑完不得写“通过”。
M1H-01–M1H-03 通过也不代表 M1H-04 通过。

## 5. 实现顺序

1. ~~建立仓库骨架~~ **已完成**：`CMakeLists.txt`、`CMakePresets.json`（`debug`）、`tests/` 接入 CTest、
   GoogleTest 经 `FetchContent` 固定为 `v1.18.0`（镜像 `gitee.com/mirrors/googletest.git`），
   `tests/smoke/` 用 `gtest_discover_tests()` 自检回路。
2. `platform.h` + Windows 采集与注入实现 + mock 实现，先让 M1U-01–M1U-03、M1U-07、M1U-10 红。
3. Session 状态机与授权门禁，覆盖 M1U-04–M1U-06、M1U-11、M1U-13。
4. 输入队列与按压释放，覆盖 M1U-08、M1U-09、M1U-12。
5. 传输层最小可用：可靠控制通道 + 不可靠视频通道，覆盖 M1U-14、M1U-15。
6. 编码/解码接入与首帧路径，跑 M1H-01–M1H-03。
7. 统计与打点，跑 M1H-04、M1H-05。

每步都以“失败测试 → 最小实现 → 全量 `ctest --preset debug` 通过”结束。

## 6. 验证命令

```bash
cmake --preset debug
cmake --build --preset debug -j
ctest --preset debug --output-on-failure
ctest --preset debug -R <模块名> --output-on-failure
```

当前仓库已建立 `CMakeLists.txt`、`CMakePresets.json` 与 `tests/smoke/`，上述四条命令均已实际运行通过，
记录在 `test-results/build/verification-loop.log`。后续步骤只能在同一个 `debug` preset 上增加目标，
不得另行引入构建系统。

## 7. 线程与资源

线程划分严格遵循 [线程模型](../../architecture/threading.md) 第 1 节，本里程碑不新增线程。
下表只列本里程碑涉及的所有权与上限；更细的帧移交契约在
[屏幕帧移交](../002-screen-frame-handoff/spec.md)。

| 资源 | 所有者（线程） | 释放位置 | 上限 / 溢出策略 |
| --- | --- | --- | --- |
| 采集帧缓冲 | Capture（经 `FramePool`） | 引用归零时在持有方线程 | 池容量固定，耗尽返回空，不扩容 |
| 采集帧槽 | Capture 写入、Encode 读取 | — | 1 帧，新帧覆盖旧帧 |
| 编码输出缓冲 | Encode | Encode 线程，会话结束时 | 按 ≤ 2 帧等价字节估算，丢最旧非参考帧 |
| 发送队列 | Network | Network 线程 | 有界；溢出记数并丢弃，不阻塞 Encode |
| 输入队列 | Input | Input 线程 | 每端 32 条、≤ 500 ms；超限结束会话并释放按压 |
| 统计事件队列 | Writer | Writer 线程 | 4096 条；溢出标记证据不完整 |
| 会话状态 | Session | Session 串行执行器 | 单实例，不跨线程共享可变状态 |

约束：

- 池与队列的构造发生在会话启动阶段，销毁按
  [架构总览](../../architecture/overview.md) 5.3 的顺序，两线程退出之后。
- 热路径（Capture / Encode / Network / Input）禁止动态分配与同步文件 I/O。
- 任何新增线程或线程池都属架构变更，须先改 [线程模型](../../architecture/threading.md) 并获批。

### 7.1 风险

- 传输层自研（见 [架构总览](../../architecture/overview.md) D1）：拥塞与丢包策略在局域网外不可用，
  M1 的结论不能外推到公网。
- 编码器可用性依赖目标机型与驱动，须按实测记录，不按设备型号猜。
- 真机延迟受显示器刷新率与测量工具影响；软件打点不能代替物理画面测量。
- Windows 采集在 DPI 变化、显示器热插拔时的行为需真机验证。

## 8. 依赖与待决项

依赖：M1 除 GoogleTest（测试期）外不引入第三方库。加密库、编解码库均未选型，
引入前须按 [AGENTS.md §3](../../../AGENTS.md) 审批并回改本文件。

待决项，未定前不实现：

1. **控制端平台。** 本规格的验收表按控制端为 Windows 编写。若首版必须支持 Android，
   需增加 `src/platform/android/`、JNI 桥与图形上下文适配，并补规格说明线程映射与依赖引入；
   这属于新增平台，须单独批准（见 [架构总览](../../architecture/overview.md) 第 10 节）。
2. **加密库与编解码库选型。** 均属新增第三方依赖，须按 [AGENTS.md §3](../../../AGENTS.md) 审批。
3. **视频编码格式。** 协议 v1 只列 `h264-baseline`；若目标机型不支持，须先改协议与本规格。
4. **传输握手消息形状。** 待依赖与加密方案确定后补进 [控制协议](../../protocol/README.md) 第 8 节。
