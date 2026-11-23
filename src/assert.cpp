// 职责：assert.h 中计数接口的实现。
// Thread: any
//
// 内部使用原子计数，无锁，可在任意线程调用。

#include <remotedesktop/assert.h>

#include <atomic>

namespace rd {
  namespace {

    std::atomic<std::uint64_t> g_suppressed_asserts{0};

  }  // namespace

  std::uint64_t suppressed_assert_count() noexcept {
    return g_suppressed_asserts.load(std::memory_order_relaxed);
  }

  void reset_suppressed_assert_count() noexcept {
    g_suppressed_asserts.store(0, std::memory_order_relaxed);
  }

  namespace detail {

    void bump_suppressed_assert() noexcept {
      g_suppressed_asserts.fetch_add(1, std::memory_order_relaxed);
    }

  }  // namespace detail
}  // namespace rd
