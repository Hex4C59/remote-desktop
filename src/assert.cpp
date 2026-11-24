// 职责：assert.h 中计数接口的实现。
// Thread: any
//
// 内部使用原子计数，无锁，可在任意线程调用。

#include <remotedesktop/assert.h>

#include <atomic>

#ifndef NDEBUG
#include <cstdlib>
#include <iostream>
#endif  // NDEBUG

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

#ifndef NDEBUG

    void abort_with_assert_message(const char* condition, const char* message,
                                   const char* file, int line) noexcept {
      std::cerr << "RD_ASSERT failed: " << condition;
      if (message != nullptr) {
        std::cerr << " | " << message;
      }
      std::cerr << " (" << file << ':' << line << ")\n";
      std::abort();
    }

#endif  // NDEBUG

  }  // namespace detail
}  // namespace rd
