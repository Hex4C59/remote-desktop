# spec-screen-frame-handoff：屏幕捕获帧的移交与所有权

status: approved
approved-by: user, 2026-11-19（用户确认首个功能规格取“帧移交”）

本文定义 Capture 线程与 Encode 线程之间唯一的帧传递通道。它是
[AGENTS.md §6.1](../AGENTS.md) “Capture 线程绝不阻塞在编码器上”这一不变量的具体落地。

上游里程碑：[spec-lan-vertical-slice.md](spec-lan-vertical-slice.md)（状态 `draft`）。
本规格独立成立：它只描述进程内的内存与所有权契约，不涉及会话、传输或平台具体实现，
因此可以在里程碑规格仍待定时先行批准。**批准本规格不授权实现会话、传输、输入或平台层。**

架构背景见 [architecture.md](../docs/architecture.md) 5.2，线程模型见
[threading.md](../docs/threading.md) 第 1–3 节，平台侧采集接口见
[platform-abstraction.md](../docs/platform-abstraction.md) 第 3 节。

## 1. 范围

做：

- 预分配帧池与其容量规则。
- 单槽覆盖式移交（SPSC）的接口、所有权与释放时机。
- 时间戳与显示映射版本的传递规则。
- 池耗尽、帧被覆盖、消费方滞后时的行为。

不做：

- 平台采集实现（`ScreenCapture` 的 Windows 实现属另一份规格）。
- 编码本身、码率控制、关键帧策略。
- 跨进程或跨设备传递。
- 纹理/GPU 零拷贝路径；本文只约束 CPU 缓冲，扩展须改本文件。

## 2. 接口契约

```cpp
// 职责：持有一次采集结果的元数据与像素视图。
// 线程归属：元数据只读，任何线程可读；引用计数可被两个线程并发递减。

enum class PixelFormat : std::uint8_t { kBGRA8 };

struct FrameDesc {
  std::uint32_t width{};
  std::uint32_t height{};
  std::uint32_t stride{};                  // 字节，含行尾填充
  PixelFormat format{PixelFormat::kBGRA8};
  std::uint64_t capture_timestamp_ns{};    // 采集侧单调时钟
  std::uint32_t display_map_version{};     // 与 platform-abstraction 第 6 节一致
};

class Frame {
 public:
  const FrameDesc& desc() const noexcept;
  std::span<const std::byte> pixels() const noexcept;  // 长度 == stride * height

  // 丢弃本引用。引用计数归零时帧回到所属池。
  // 线程：任何持有引用的线程。
  void release() noexcept;

  Frame(const Frame&) = delete;
  Frame& operator=(const Frame&) = delete;
  Frame(Frame&&) = delete;
  Frame& operator=(Frame&&) = delete;

 private:
  // 只有 FramePool 能构造与销毁。禁止 delete frame：帧的生命周期由池独占，
  // 外部删除会破坏池的空闲链表。
  friend class FramePool;
  Frame(FramePool* pool, std::span<std::byte> buffer) noexcept;
  ~Frame() = default;

  std::atomic<std::uint32_t> refs_{1};   // 初始为 1，代表池交出时的唯一引用
  FrameDesc desc_;
  std::span<std::byte> buffer_;
  FramePool* pool_;      // 池必须比所有帧活得久
};

// 职责：预分配固定数量帧，提供获取与回收。
// 线程归属：构造在 Capture 线程启动前完成；回收由 release() 触发，
//           因此池内部结构必须线程安全，且不得在回收路径分配内存。

class FramePool {
 public:
  // capacity 为帧数，固定不变。frame_bytes 为单帧缓冲上限。
  // 前置条件：capacity >= 1 且 frame_bytes >= 单像素字节数；
  //           零值属于调用方错误，Debug 下 RD_ASSERT，Release 下抛 std::invalid_argument。
  // 内存不足时抛 std::bad_alloc。两者都发生在启动阶段，允许异常。
  FramePool(std::uint32_t capacity, std::size_t frame_bytes);
  ~FramePool();

  // 取一个空闲帧，引用计数为 1，所有权归调用方。
  // 无空闲时返回 nullptr，不阻塞、不分配。
  // 线程：任何线程；实现须无锁，不得在热路径取互斥量。
  [[nodiscard]] Frame* try_acquire_free() noexcept;

  // 仅用于统计与测试断言。两者都是瞬时快照，
  // 并发读取时两值之和可能因中间状态而不等于 capacity，
  // 必须在单线程（两线程均已空闲）时才可断言守恒。
  std::uint32_t in_use() const noexcept;
  std::uint32_t free_count() const noexcept;

  FramePool(const FramePool&) = delete;
  FramePool& operator=(const FramePool&) = delete;
};

// 职责：Capture → Encode 的单槽覆盖式移交。
// 线程归属：publish() 只允许 Capture 线程调用；
//           try_acquire() 只允许 Encode 线程调用。两端各只有一个线程。

class FrameSlot {
 public:
  FrameSlot() = default;

  // 取得传入引用的所有权。
  // 若槽中已有未被取走的帧，该旧帧被释放一次（可能因此回到池）。
  // 调用方在 publish() 之后不得再对该帧调用 release()，否则重复释放。
  // 不阻塞、不分配。f 为空时槽内容不变，否则槽内变为 f。
  void publish(Frame* f) noexcept;

  // 取走槽中帧并向其增加一个引用；槽变为空。
  // 调用方取得该引用，用完后必须且只能 release() 一次。
  // 无帧时返回 nullptr。
  [[nodiscard]] Frame* try_acquire() noexcept;

 private:
  std::atomic<Frame*> slot_{nullptr};
};
```

错误处理：本模块不使用 `std::expected`。失败一律以“返回 `nullptr`”或“丢弃旧帧”表达，
因为这两种情况都在热路径上、都属于可承受的降级，不需要向上传播错误码。
帧池构造失败（内存不足）在启动阶段抛出 `std::bad_alloc` 并由上层转为启动错误；
这是唯一允许的异常出口，因为此时尚无实时性要求。

两个接口在调用方漏检返回值时会产生隐式 bug，因此 `try_acquire_free()` 与
`try_acquire()` 都标记 `[[nodiscard]]`。

## 3. 不变量

1. **Capture 永不阻塞于 Encode。** `publish()` 不等待、不重试、不分配内存、不取互斥量，
   最坏情况只是丢弃槽中旧帧。
2. **槽内最多一帧。** `publish()` 覆盖旧帧，不排队。连续 10 次 `publish()`
   而 `try_acquire()` 一次未调用时，槽内只有最后一帧，前 9 帧已各被释放一次。
3. **守恒（单线程快照）。** 在无并发操作时，`in_use() + free_count()` 等于构造时的
   `capacity`。并发期间两者各自是瞬时快照，**不得**用并发读出的两值做守恒断言，
   测试须在两线程空闲后检查。
4. **引用计数配平。** 每次成功 `try_acquire()` 或 `try_acquire_free()` 取得的引用
   对应恰好一次 `release()`；`publish()` 接管传入引用的所有权，调用方不得再 `release()`。
   同一帧可被两个线程各持一个引用，两次 `release()` 后回到池。
5. **时间戳单调（单线程）。** 由同一个 Capture 线程连续 `publish()` 的帧，
   其 `capture_timestamp_ns` 不得递减。跨线程或跨池不做此断言：
   不同线程的单调时钟起点不可比。违反时在 Debug 构建断言失败。
6. **池不扩容。** 构造后 `capacity` 与 `frame_bytes` 不变；`try_acquire_free()`
   在耗尽时返回 `nullptr`，绝不分配。
7. **池寿命覆盖所有帧。** 所有帧 `release()` 完成后才允许销毁池；
   违反属未定义行为，Debug 构建须能检测（析构时仍有未回收帧即断言失败）。
8. **帧不可外部删除。** `Frame` 只能由 `FramePool` 构造与销毁；外部只持有裸指针并
   `release()`，不得 `delete`。此条由 `Frame` 的私有构造/析构加 `friend FramePool` 强制。
9. **发布不产生额外引用。** `publish(f)` 前后 `f` 的引用计数不变（仅所有权从调用方转到槽）；
   只有覆盖旧帧时才对旧帧减一。

## 4. 线程与资源

| 项 | 规则 |
| --- | --- |
| 池的构造 | 会话启动阶段，**Capture 与 Encode 线程均尚未创建之前**；容量为编译期常量 |
| 池的销毁 | 按 [architecture.md](../docs/architecture.md) 5.3 第 3 步：两线程均已退出、槽已置空、所有帧已释放之后 |
| `publish()` | 仅 Capture 线程 |
| `try_acquire()` | 仅 Encode 线程 |
| `try_acquire_free()` | Capture 线程（开帧）；构造阶段也允许 |
| `Frame::release()` | 持有该引用的线程（Capture 丢弃旧帧时在 Capture 线程，Encode 用完时在 Encode 线程） |
| 队列类型 | 单槽覆盖式（容量 1，丢弃最旧），见 [threading.md](../docs/threading.md) 第 3 节 |
| 热路径分配 | 禁止。所有缓冲在 `FramePool` 构造时一次分配 |
| 热路径加锁 | 禁止。池的空闲链表与槽位均用原子操作 |

`FramePool` 的回收路径由 `release()` 触发，可能发生在两条线程上，
因此空闲链表的维护必须使用无锁原子操作；不得用互斥量，因为 Encode 线程的
`release()` 与 Capture 线程的 `try_acquire_free()` 之间不允许互相等待。

### 4.1 断言机制

不变量 5、7、8 在 Debug 构建下断言失败。实现使用项目自有的 `RD_ASSERT`（定义于
`include/remotedesktop/assert.h`）：Debug 下为 `assert`；Release 下变为
“记录计数后继续”，不得 `abort`（生产环境不能因单帧时间戳异常而崩溃）。
两种行为都要有测试：Debug 测试断言失败（死亡测试），Release 测试断言计数增加。

## 5. 验收场景

全部可自动化，使用伪造像素缓冲，不依赖真实屏幕。测试位置 `tests/unit/capture/`。

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| FH-01 | 空槽 `try_acquire()` | 返回 `nullptr`，不改变池计数 |
| FH-02 | `publish()` 后 `try_acquire()` | 取得同一帧，`desc()` 与发布时逐字段相等，`pixels().size()` 等于 `stride * height` |
| FH-03 | `publish()` 两次再 `try_acquire()` | 只取得第二帧；第一帧已回到池（`in_use()` 由 2 降为 1） |
| FH-04 | 连续 `publish()` 10 次、不消费 | 槽内为第 10 帧，其余 9 帧已回池，`in_use()==1` |
| FH-05 | 取得帧后再 `publish()` 新帧 | 旧引用仍可读，新帧独立可取；两次 `release()` 后池全空 |
| FH-06 | `publish(nullptr)` | 槽内容不变，计数不变 |
| FH-07 | 池耗尽（全部帧被持有）后 `try_acquire_free()` | 返回 `nullptr`，不分配，计数不变 |
| FH-08 | 全部 `release()` 后（单线程） | `in_use()==0`，`free_count()==capacity` |
| FH-09 | 随机操作序列（属性测试） | 每步后的单线程快照满足守恒；无泄漏 |
| FH-10 | Debug 下发布时间戳递减的帧 | 死亡测试：`RD_ASSERT` 触发 |
| FH-11 | Debug 下池析构时仍有帧未释放 | 死亡测试：`RD_ASSERT` 触发 |
| FH-12 | 两线程各持同一帧再各自 `release()` | 计数归零，帧回池，无重复释放 |
| FH-13 | `publish(f)` 后读 `f` 的引用计数 | 与 publish 前相等（不变式 9） |
| FH-14 | 取得帧后不 `release()` 就重新 `try_acquire_free()` 到耗尽 | 总能取到直到容量上限，随后返回 `nullptr` |
| FH-15 | Release 构建下发布时间戳递减的帧 | 不崩溃，下降计数 +1（断言降级为计数） |
| FH-16 | 帧描述零尺寸（`width==0` 或 `height==0`） | `FramePool` 不涉及单帧尺寸，由采集侧填写 `FrameDesc` 时拒绝：Debug 下 `RD_ASSERT`，Release 下丢弃该帧、不 `publish()` |

属性测试：FH-09 用随机 `publish`/`acquire`/`release` 序列（长度 ≥ 10000 步、固定种子可复现），
断言池守恒与引用计数自洽。触发失败的序列要保存为回归用例。

并发测试：FH-12 以及一个“Capture 循环 publish + Encode 循环 acquire/release”的
双线程压力用例（运行 ≥ 1 秒），断言无泄漏、无崩溃、无 `in_use()` 超容量。
该用例断言的是正确性，不是延迟；延迟由里程碑验收单独测量。

## 6. 依赖与待决项

依赖：仅 C++20 标准库（`<atomic>`、`<span>`、`<cstddef>`）。不引入第三方库。

待决项，确定后须回改本文件：

1. **帧容量与 `frame_bytes` 的具体数值。** 当前未定。`capacity` 的初值倾向 3
   （Capture 持有 1、Encode 持有 1、回收缓冲 1），须在实现时由实测支撑，
   不能因为“看起来够”就固定。
2. **是否需要帧池降级统计。** 丢弃旧帧的次数目前只作为统计候选，
   未进入本规格的接口；若要作为验收指标，须新增计数接口。
3. **GPU/纹理路径。** 若后续引入原生纹理缓冲，`Frame::pixels()` 的 CPU 视图假设失效，
   须改本文件并重新验收。
4. **`display_map_version` 的赋值方。** 由平台层在采集时填入还是由 Capture 线程填写，
   待平台采集规格确定。
