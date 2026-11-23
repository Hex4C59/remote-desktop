// 职责：frame_handoff 的实现：预分配帧池与 SPSC 单槽移交。
// Thread: any（FramePool 的回收可发生在两条线程；FrameSlot
// 为单发布者/单消费者）
//
// FramePool 构造在两条线程启动前完成；release() 与 try_acquire_free() 可并发，
// 故空闲结构无锁。FrameSlot 的 publish() 只允许 Capture，try_acquire() 只允许
// Encode。

#include <remotedesktop/frame_handoff.h>

#include <cstdint>
#include <new>
#include <stdexcept>

#include <remotedesktop/assert.h>

namespace rd {
  namespace {
    constexpr std::uint64_t kIndexMask = 0xFFFF'FFFFull;

    // 空闲头：高 32 位版本号，低 32 位为"索引 + 1"（0 表示空）。
    // 版本号在每次 CAS 成功时递增，避免 ABA。
    std::uint64_t next_head(std::uint64_t old,
                            std::uint32_t index_plus_one) noexcept {
      const std::uint64_t tag = (old >> 32) + 1;
      return (tag << 32) | index_plus_one;
    }
  }  // namespace

  Frame::Frame(FramePool* pool, std::span<std::byte> buffer) noexcept
      : buffer_(buffer), pool_(pool) {}

  const FrameDesc& Frame::desc() const noexcept { return desc_; }

  std::span<const std::byte> Frame::pixels() const noexcept {
    const auto bytes = static_cast<std::size_t>(desc_.stride) * desc_.height;
    return {buffer_.data(), bytes};
  }

  FrameDesc* Frame::mutable_desc() noexcept {
    if (published_.load(std::memory_order_acquire)) {
      RD_ASSERT(false);
      return nullptr;
    }
    return &desc_;
  }

  std::span<std::byte> Frame::mutable_pixels() noexcept {
    if (published_.load(std::memory_order_acquire)) {
      RD_ASSERT(false);
      return {};
    }
    return buffer_;
  }

  void Frame::add_ref() noexcept {
    if (!published_.load(std::memory_order_acquire)) {
      RD_ASSERT(false);
      return;
    }
    refs_.fetch_add(1, std::memory_order_relaxed);
  }

  void Frame::release() noexcept {
    if (refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) {
      pool_->recycle(this);
    }
  }

  FramePool::FramePool(std::uint32_t capacity, std::size_t frame_bytes)
      : capacity_(capacity), frame_bytes_(frame_bytes) {
    if (capacity == 0 || frame_bytes < 4) {
      RD_ASSERT(false);
      throw std::invalid_argument(
          "FramePool: capacity >= 1 and frame_bytes >= 4");
    }

    frame_storage_.reset(new std::byte[sizeof(Frame) * capacity_]);
    buffer_storage_.reset(new std::byte[frame_bytes_ * capacity_]);
    next_free_.reset(new std::uint32_t[capacity_]);
    frames_ = reinterpret_cast<Frame*>(frame_storage_.get());

    for (std::uint32_t i = 0; i < capacity_; ++i) {
      const std::size_t offset = static_cast<std::size_t>(i) * frame_bytes_;
      new (frames_ + i) Frame(
          this,
          std::span<std::byte>(buffer_storage_.get() + offset, frame_bytes_));
      // 后继存“索引 + 1”：0 表示链表结束。
      next_free_[i] = (i + 1 < capacity_) ? i + 2 : 0;
    }
    free_head_.store(1, std::memory_order_relaxed);  // 0 号帧，版本号 0
  }

  FramePool::~FramePool() {
    RD_ASSERT(in_use_.load(std::memory_order_relaxed) == 0);
    for (std::uint32_t i = 0; i < capacity_; ++i) {
      frames_[i].~Frame();
    }
  }

  Frame* FramePool::try_acquire_free() noexcept {
    std::uint64_t head = free_head_.load(std::memory_order_acquire);
    for (;;) {
      const auto index_plus_one = static_cast<std::uint32_t>(head & kIndexMask);
      if (index_plus_one == 0) return nullptr;
      const std::uint32_t index = index_plus_one - 1;
      const std::uint64_t desired = next_head(head, next_free_[index]);
      if (free_head_.compare_exchange_weak(head, desired,
                                           std::memory_order_acq_rel,
                                           std::memory_order_acquire)) {
        in_use_.fetch_add(1, std::memory_order_relaxed);
        return frames_ + index;
      }
    }
  }

  std::uint32_t FramePool::in_use() const noexcept {
    return in_use_.load(std::memory_order_relaxed);
  }

  std::uint32_t FramePool::free_count() const noexcept {
    return capacity_ - in_use_.load(std::memory_order_relaxed);
  }

  void FramePool::recycle(Frame* frame) noexcept {
    const auto index = static_cast<std::uint32_t>(frame - frames_);
    std::uint64_t head = free_head_.load(std::memory_order_relaxed);
    for (;;) {
      next_free_[index] = static_cast<std::uint32_t>(head & kIndexMask);
      const std::uint64_t desired = next_head(head, index + 1);
      if (free_head_.compare_exchange_weak(head, desired,
                                           std::memory_order_acq_rel,
                                           std::memory_order_relaxed)) {
        in_use_.fetch_sub(1, std::memory_order_relaxed);
        return;
      }
    }
  }

  void FrameSlot::publish(Frame* f) noexcept {
    if (f == nullptr) return;  // FH-06：无操作
    if (shutdown_done_.load(std::memory_order_acquire)) {
      RD_ASSERT(false);
      return;
    }
    // 置位后写入视图失效；acq_rel 交换把发布前的写入交给取得方。
    f->published_.store(true, std::memory_order_relaxed);
    Frame* old = slot_.exchange(f, std::memory_order_acq_rel);
    if (old != nullptr) old->release();
  }

  Frame* FrameSlot::try_acquire() noexcept {
    return slot_.exchange(nullptr, std::memory_order_acq_rel);
  }

  void FrameSlot::drain_for_shutdown() noexcept {
    if (shutdown_done_.exchange(true, std::memory_order_acq_rel)) {
      RD_ASSERT(false);  // 重复清槽
      return;
    }
    Frame* old = slot_.exchange(nullptr, std::memory_order_acq_rel);
    if (old != nullptr) old->release();
  }
}  // namespace rd
