// 职责：Capture → Encode 的帧池与单槽移交契约。
// Thread: any（FramePool 可被两条线程回收；FrameSlot 为 SPSC，见各成员注释）。
//
// 本文件是 FrameDesc / PixelFormat / Frame / FramePool / FrameSlot
// 的唯一定义处，
// 其他文档只能引用不得重述。规格：docs/increments/002-screen-frame-handoff/spec.md 第 2 节。

#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>

namespace rd {
  enum class PixelFormat : std::uint8_t { kBGRA8 };

  struct FrameDesc {
    std::uint32_t width{};
    std::uint32_t height{};
    std::uint32_t stride{};  // 字节，含行尾填充
    PixelFormat format{PixelFormat::kBGRA8};
    std::uint64_t capture_timestamp_ns{};  // 采集侧单调时钟
    std::uint32_t display_map_version{};  // 与 platform-abstraction 第 6 节一致
  };

  class FramePool;

  // 职责：持有一次采集结果的元数据与像素视图。
  // 线程归属：发布前只由 Capture 线程写入；发布后所有持有者只读，
  //           引用计数可被两条线程并发递减。
  class Frame {
   public:
    const FrameDesc& desc() const noexcept;
    std::span<const std::byte> pixels()
        const noexcept;  // 长度 == stride * height

    // 写入视图：仅采集侧在 publish() 之前使用。返回池分配的完整缓冲
    // （长度 == frame_bytes），几何尚未校验。发布后调用属违例：
    // Debug 下 RD_ASSERT，Release 下返回 nullptr / 空 span。
    // Thread: capture only
    FrameDesc* mutable_desc() noexcept;
    std::span<std::byte> mutable_pixels() noexcept;  // 长度 == frame_bytes

    // 丢弃本引用。引用计数归零时帧回到所属池。
    // 线程：任何持有引用的线程。
    void release() noexcept;

    // 显式复制一个读引用；每次调用必须配对一次 release()。
    // 只能在帧已 publish() 之后调用；未发布时 Debug 下 RD_ASSERT。
    void add_ref() noexcept;

    Frame(const Frame&) = delete;
    Frame& operator=(const Frame&) = delete;
    Frame(Frame&&) = delete;
    Frame& operator=(Frame&&) = delete;

   private:
    // 只有 FramePool 能构造与销毁；FrameSlot 只能在移交时置位 published_。
    friend class FramePool;
    friend class FrameSlot;
    Frame(FramePool* pool, std::span<std::byte> buffer) noexcept;
    ~Frame() = default;

    std::atomic<std::uint32_t> refs_{1};  // 初始为 1，代表池交出时的唯一引用
    std::atomic<bool> published_{false};  // 发布标记；门控写入视图与 add_ref
    FrameDesc desc_;
    std::span<std::byte> buffer_;
    FramePool* pool_;  // 池必须比所有帧活得久
  };

  // 职责：预分配固定数量帧，提供获取与回收。
  // 线程归属：构造在 Capture 线程启动前完成；回收由 release() 触发，
  //           池内部结构无锁，回收路径不分配内存。
  class FramePool {
   public:
    // capacity >= 1 且 frame_bytes >= 4（kBGRA8 单像素 4 字节）。
    // 违反前置条件：Debug 下 RD_ASSERT，Release 下抛 std::invalid_argument；
    // 内存不足抛 std::bad_alloc。
    FramePool(std::uint32_t capacity, std::size_t frame_bytes);
    ~FramePool();

    // 取一个空闲帧，引用计数为 1，所有权归调用方。无空闲时返回 nullptr，
    // 不阻塞、不分配。
    [[nodiscard]] Frame* try_acquire_free() noexcept;

    // 仅用于统计与测试断言；并发期间两值都是瞬时快照。
    std::uint32_t in_use() const noexcept;
    std::uint32_t free_count() const noexcept;

    FramePool(const FramePool&) = delete;
    FramePool& operator=(const FramePool&) = delete;

   private:
    friend class Frame;
    void recycle(Frame* frame) noexcept;

    std::uint32_t capacity_{0};
    std::size_t frame_bytes_{0};
    std::unique_ptr<std::byte[]> frame_storage_;   // capacity_ 个 Frame 对象
    std::unique_ptr<std::byte[]> buffer_storage_;  // capacity_ * frame_bytes_
    Frame* frames_{nullptr};
    std::unique_ptr<std::uint32_t[]> next_free_;  // 空闲链表后继（索引 + 1）
    std::atomic<std::uint64_t> free_head_{
        0};  // 高 32 位版本号 | 低 32 位索引 + 1
    std::atomic<std::uint32_t> in_use_{0};
  };

  // 职责：Capture → Encode 的单槽覆盖式移交（容量 1，丢弃最旧）。
  // 线程归属：publish() 只允许 Capture 线程；try_acquire() 只允许 Encode 线程；
  //           drain_for_shutdown() 只在两线程 join 后串行调用一次。
  class FrameSlot {
   public:
    FrameSlot() = default;

    // 接管 f 的所有权并用一次原子交换替换槽内容；f 为空时是无操作。
    // 调用方在 publish() 之后不得再对该帧调用 release()。
    void publish(Frame* f) noexcept;

    // 取走槽中帧并接管其唯一引用；无帧时返回 nullptr。
    [[nodiscard]] Frame* try_acquire() noexcept;

    // 关闭流程专用：原子置空并对槽内最后一帧 release() 一次。
    // 置位后 publish() 被忽略、try_acquire() 恒返回 nullptr。
    void drain_for_shutdown() noexcept;

   private:
    std::atomic<Frame*> slot_{nullptr};
    std::atomic<bool> shutdown_done_{false};
  };

  // FH-19：热路径原子类型必须无锁，不满足的平台在此编译失败。
  static_assert(std::atomic<Frame*>::is_always_lock_free,
                "FH-19: std::atomic<Frame*> 必须无锁");
  static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
                "FH-19: std::atomic<std::uint64_t> 必须无锁");
  static_assert(std::atomic<std::uint32_t>::is_always_lock_free,
                "FH-19: std::atomic<std::uint32_t> 必须无锁");
  static_assert(std::atomic<bool>::is_always_lock_free,
                "FH-19: std::atomic<bool> 必须无锁");
}  // namespace rd
