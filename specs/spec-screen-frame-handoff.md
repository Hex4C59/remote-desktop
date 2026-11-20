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

本节是 `FrameDesc` 与 `PixelFormat` 的**唯一定义**，其他文档只能引用不得重述。
[spec-platform-win.md](spec-platform-win.md) 2.1 记录了与 docs 旧版本的合并决定。

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

// FrameDesc 有效性前置条件（由采集侧在填写 desc_ 时校验，池构造期不校验单帧几何）：
//   stride >= uint64_t(width) * 4        （禁止 32 位溢出；width > 0）
//   uint64_t(stride) * height <= frame_bytes（全部按 uint64 计算，禁止溢出后截断）
//   height > 0
// Frame::pixels() 返回长度 stride * height 的视图；上述任一条件不成立时，
// 该 span 会越过池分配的 frame_bytes 缓冲。
// 违反时：若帧已由 try_acquire_free() 取得，先恰好 release() 一次归还池，
// 再按构建处理——Debug 下触发 RD_ASSERT（死亡测试只断言断言本身），
// Release 下丢弃该帧、不调用 publish()、下降计数 +1（池计数恢复由 Release 测试验证）。
// 禁止「拒绝发布但不归还」，否则池会被永久占用（FH-21）。
// 校验失败属于采集侧输入错误，不在热路径传播错误码。

class Frame {
 public:
  const FrameDesc& desc() const noexcept;
  std::span<const std::byte> pixels() const noexcept;  // 长度 == stride * height

  // 丢弃本引用。引用计数归零时帧回到所属池。
  // 线程：任何持有引用的线程。
  void release() noexcept;

  // 显式复制一个引用；每次调用必须配对一次 release()。
  // 只能在仍持有有效引用时调用，禁止对已归还池的帧调用。
  // 帧内容在 publish() 之后不可变：所有持有者只能读 desc()/pixels()，
  // 任何持有者不得写 desc_ 或 buffer_；add_ref() 只复制读引用，不建立写权限。
  // publish()/try_acquire() 的 acq_rel exchange 建立发布前写入与取得后读取的
  // happens-before，故多持有者并发只读无数据竞争（FH-12）。
  void add_ref() noexcept;

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
  // 前置条件：capacity >= 1 且 frame_bytes >= 4（kBGRA8 单像素 4 字节）；
  //           违反前置条件时 Debug 下 RD_ASSERT，Release 下抛 std::invalid_argument。
  //           内存不足时抛 std::bad_alloc。
  // 这两个异常都是启动阶段允许的异常出口（见 §2 错误处理）；此时尚无实时性要求。
  FramePool(std::uint32_t capacity, std::size_t frame_bytes);
  ~FramePool();

  // 取一个空闲帧，引用计数为 1，所有权归调用方。
  // 无空闲时返回 nullptr，不阻塞、不分配；此时 Capture 必须跳过本次采集，
  // 不得阻塞、重试或继续探测（见 FH-07）。
  // 若该帧随后因 FrameDesc 校验失败被丢弃，必须先恰好 release() 一次再跳过，
  // 否则池会被永久占用（见 FH-21）。
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
//
// 生命周期前置条件（SPSC，不支持并发发布/并发清槽）：
//   - 整个生命周期内只有一个 Capture 发布者，禁止两个线程并发 publish()；
//   - 禁止 publish()/try_acquire() 与清槽并发；
//   - 清槽只能通过下面声明的 drain_for_shutdown()，在 Capture/Encode 线程
//     都已 join 之后由关闭流程串行调用一次，见 architecture.md 5.3 与 FH-20。
// FrameSlot 不检测线程是否已退出：由调用方（会话关闭流程）保证 join 已完成；
// 违反该前置条件属调用方错误，规格不要求 FrameSlot 在 Release 下识别它。
// FrameSlot 只检测「重复清槽」：drain_for_shutdown() 第二次调用时 Debug 下
// RD_ASSERT、Release 下无操作。若未来需要多发布者或并发清槽，必须另写规格、
// 证明完整所有权协议并重新验收，本规格不提供该能力。
//
// 原子移交协议（唯一允许的实现，防止 use-after-free）：
//   slot_ 是 std::atomic<Frame*>，两个操作都必须用一次 exchange() 完成所有权
//   转移；禁止先 load()/compare 再对同一 Frame* 操作。
//   publish(f):   old = slot_.exchange(f, std::memory_order_acq_rel);
//                 old != nullptr 时，仅对 old 调用一次 release()。
//   try_acquire(): f = slot_.exchange(nullptr, std::memory_order_acq_rel);
//                 返回 f；成功时调用方接管槽中那一个引用，
//                 不得再隐式 add_ref()，用完后恰好 release() 一次。
// 在单发布者前提下，交换保证同一个 Frame* 只会被 publish 或 try_acquire 之一取得：
// 不会出现「Encode 刚读到指针、Capture 已把同一帧归还池并被复用」的竞态。
// 禁止实现：先 load slot_，再对该指针递增引用计数、release() 或读
// desc()/pixels()；该窗口内 publish() 可能已释放并使指针失效。

class FrameSlot {
 public:
  FrameSlot() = default;

  // 取得传入引用的所有权，并用一次原子交换替换槽内容。
  // 若槽中已有未被取走的帧，该旧帧被释放一次（可能因此回到池）。
  // 调用方在 publish() 之后不得再对该帧调用 release()，否则重复释放。
  // 不阻塞、不分配。f 为空时是**无操作**：槽内容与计数都不变；
  // 关闭清槽必须调用 drain_for_shutdown()，不得用 publish(nullptr)。
  void publish(Frame* f) noexcept;

  // 用一次原子交换取走槽中帧并接管其唯一引用；槽变为空。
  // 调用方用完后必须且只能 release() 一次。
  // 无帧时返回 nullptr。
  [[nodiscard]] Frame* try_acquire() noexcept;

  // 仅供关闭流程调用：两线程已 join 后串行执行一次。
  //   old = slot_.exchange(nullptr, std::memory_order_acq_rel);
  //   if (old) old->release();
  // 原子置空并对槽内最后一帧恰好 release() 一次；不得在热路径调用。
  // 重复调用：Debug 下 RD_ASSERT，Release 下无操作（由 shutdown_done_ 检测）。
  void drain_for_shutdown() noexcept;

 private:
  std::atomic<Frame*> slot_{nullptr};
  std::atomic<bool> shutdown_done_{false};
};
```

错误处理：本模块不使用 `std::expected`。热路径失败一律以“返回 `nullptr`”、
“跳过本次采集”或“丢弃旧帧”表达，不传播错误码、不抛异常。
启动阶段有两个允许的异常出口，此时尚无实时性要求：

1. 内存不足：`FramePool` 构造抛 `std::bad_alloc`，由上层转为启动错误。
2. 构造参数非法（`capacity == 0` 或 `frame_bytes < 4`）：Debug 下 `RD_ASSERT`，
   Release 下抛 `std::invalid_argument`，由上层转为启动错误。

除上述两项外，`publish()` / `try_acquire()` / `try_acquire_free()` / `release()`
在任何构建下都不得抛异常。

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
4. **引用计数配平。** 每次成功 `try_acquire_free()` 取得的引用、每次
   `try_acquire()` 从槽接管的引用、以及每次显式 `add_ref()` 新增的引用，
   都各自对应恰好一次 `release()`；`publish()` 接管传入引用的所有权，
   调用方不得再 `release()`。帧回到池当且仅当所有引用都已释放；若确实需要
   两个线程各持同一帧的一个引用，必须由持有者显式调用一次 `add_ref()` 并配对
   `release()`，不得依赖 `try_acquire()` 隐式复制引用。
5. **时间戳单调（单线程）。** 由同一个 Capture 线程连续 `publish()` 的帧，
   其 `capture_timestamp_ns` 不得递减。跨线程或跨池不做此断言：
   不同线程的单调时钟起点不可比。违反时在 Debug 构建断言失败。
6. **池不扩容、耗尽即跳过。** 构造后 `capacity` 与 `frame_bytes` 不变；
   `try_acquire_free()` 在耗尽时返回 `nullptr`，绝不分配、绝不阻塞；此时 Capture
   跳过本次采集。任何已取得但因 `FrameDesc` 校验失败而丢弃的帧必须恰好
   `release()` 一次，保证池计数恢复。
7. **池寿命覆盖所有帧。** 所有帧 `release()` 完成后才允许销毁池；
   违反属未定义行为，Debug 构建须能检测（析构时仍有未回收帧即断言失败）。
8. **帧不可外部删除。** `Frame` 只能由 `FramePool` 构造与销毁；外部只持有裸指针并
   `release()`，不得 `delete`。此条由 `Frame` 的私有构造/析构加 `friend FramePool` 强制。
9. **发布不产生额外引用。** `publish(f)` 前后 `f` 的引用计数不变（仅所有权从调用方转到槽）；
   只有覆盖旧帧时才对旧帧减一，且该旧帧必须来自同一次 `exchange()` 的返回值。
10. **单原子移交。** `publish()` 与 `try_acquire()` 对 `slot_` 各使用一次
    `exchange(std::memory_order_acq_rel)` 完成所有权转移；任一 `Frame*` 只能被
    其中一个操作取得一次。禁止用 `load()` 观察槽内容后再对该指针做引用计数、
    `release()` 或 `desc()`/`pixels()` 读取；该窗口内 `publish()` 可能已释放并使
    指针失效。Debug 与 Release 使用同一协议，不得存在「先读后释放」的快路径。
11. **单发布者、串行清槽。** 整个生命周期只有一个 Capture 发布者；
    `publish()` 不得并发；清槽只能通过 `drain_for_shutdown()` 在两线程 join 后
    串行执行一次，FrameSlot 只检测重复清槽（Debug 断言 / Release 无操作）。
    「线程是否已退出」由关闭流程保证，FrameSlot 不检测；并发发布/并发清槽属
    调用方错误，本规格不支持，扩展须另立规格（FH-20）。
12. **发布后帧内容只读。** 发布前的 `desc_`/像素写入完成后，帧内容对所有持有者
    只读；`add_ref()` 只复制读引用。`publish()`/`try_acquire()` 的 `acq_rel`
    交换建立发布前写入与取得后读取的 happens-before，因此多持有者并发只读
    `desc()`/`pixels()` 无数据竞争；任何持有者并发写帧内容均违反本规格（FH-12）。

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

`try_acquire_free()` 与 `Frame::release()` 的“无锁”要求必须可验证：实现只能使用
目标平台上 `std::atomic<T>::is_always_lock_free` 为 `true` 的原子类型
（`Frame*`、`std::uint32_t` 与 `std::atomic<bool>` 的 `shutdown_done_`），并用 `static_assert` 在编译期固定。若某目标平台
不满足，必须编译失败并在 §6 待决项登记，**不得**在运行时退化为互斥量或
libatomic 内部锁；不支持的平台不得声称满足本规格。

### 4.1 断言机制

不变量 5、7、8，FH-22 的构造参数校验，以及「重复调用
`drain_for_shutdown()`」在 Debug 构建下断言失败。FH-16/FH-17 的 `FrameDesc`
校验分两种测试：Debug 死亡测试只断言 `RD_ASSERT`（进程终止，不验证池计数恢复）；
Release 测试断言已 acquire 帧被恰好 `release()` 一次、池计数恢复。实现使用项目自有的 `RD_ASSERT`（定义于
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
| FH-06 | `publish(nullptr)` | 无操作：槽内容与计数都不变；关闭清槽必须另调 `drain_for_shutdown()`，不得用本调用 |
| FH-07 | 池耗尽（全部帧被持有）后 `try_acquire_free()` | 返回 `nullptr`，不分配、不阻塞；Capture 跳过本次采集，池计数不变 |
| FH-08 | 全部 `release()` 后（单线程） | `in_use()==0`，`free_count()==capacity` |
| FH-09 | 随机操作序列（属性测试） | 每步后的单线程快照满足守恒；无泄漏 |
| FH-10 | Debug 下发布时间戳递减的帧 | 死亡测试：`RD_ASSERT` 触发 |
| FH-11 | Debug 下池析构时仍有帧未释放 | 死亡测试：`RD_ASSERT` 触发 |
| FH-12 | 显式 `add_ref()` 后两线程各持同一帧的一个引用，再各自 `release()` | 计数归零，帧回池，无重复释放；两线程并发只读 `desc()`/`pixels()` 无数据竞争，帧内容发布后不可变 |
| FH-13 | `publish(f)` 后读 `f` 的引用计数 | 与 publish 前相等（不变式 9） |
| FH-14 | 取得帧后不 `release()` 就重新 `try_acquire_free()` 到耗尽 | 总能取到直到容量上限，随后返回 `nullptr` |
| FH-15 | Release 构建下发布时间戳递减的帧 | 不崩溃，下降计数 +1（断言降级为计数） |
| FH-16 | `FrameDesc` 零尺寸、`width > UINT32_MAX/4` 导致 `width*4` 溢出、`stride < uint64_t(width)*4` 或 `stride*height` 溢出 | 采集侧校验失败：Debug 死亡测试只断言 `RD_ASSERT`；Release 下已 acquire 的帧恰好 `release()` 一次、不 `publish()`，下降计数 +1，池计数恢复 |
| FH-17 | `uint64_t(stride) * height > frame_bytes` | 同 FH-16；`pixels()` 不得返回越过池缓冲的 span；Release 下池计数恢复 |
| FH-18 | 并发：Capture 连续 `publish()` 覆盖、Encode 同时 `try_acquire()` | 每个返回的 `Frame*` 都可安全读 `desc()`/`pixels()`，不出现已回池帧被复用；≥1 秒后引用计数守恒、无重复释放 |
| FH-19 | 构建期无锁检查 | `static_assert(std::atomic<Frame*>::is_always_lock_free && std::atomic<std::uint32_t>::is_always_lock_free && std::atomic<bool>::is_always_lock_free)`；不满足的平台编译失败并登记 |
| FH-20 | 关闭流程：两线程 join 后调用 `drain_for_shutdown()` 串行清槽 | 槽内最后一帧被恰好 `release()` 一次，池守恒；重复调用在 Debug 下 `RD_ASSERT`、Release 下无操作；清槽不与热路径 `publish()` 并发 |
| FH-21 | Release 下已 acquire 的帧因 FH-16/17 校验失败被丢弃 | 丢弃前恰好 `release()` 一次；连续 100 次丢弃后 `free_count()==capacity`（池不被永久占用） |
| FH-22 | `capacity==0` 或 `frame_bytes<4` | Debug 下 `RD_ASSERT`；Release 下抛 `std::invalid_argument`，不创建池 |

属性测试：FH-09 用随机 `publish`/`acquire`/`release` 序列（长度 ≥ 10000 步、固定种子可复现），
断言池守恒与引用计数自洽。触发失败的序列要保存为回归用例。

并发测试：FH-12、FH-18、FH-20 以及一个“Capture 循环 publish + Encode 循环 acquire/release”的
双线程压力用例（运行 ≥ 1 秒），断言无泄漏、无崩溃、无 `in_use()` 超容量，
且没有「读指针时该帧已被归还池」的竞态。
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
5. **无锁原子支持的目标平台清单。** 首版只支持 `std::atomic<Frame*>`、
   `std::atomic<std::uint32_t>` 与 `std::atomic<bool>` 的 `is_always_lock_free`
   均为 `true` 的目标；新增平台须先实测、在 FH-19 登记并回改本文件，不得静默降级。
