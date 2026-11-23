// 职责：验证 include/remotedesktop/assert.h 的 Debug/Release 两种行为。
// 线程归属：无（单线程测试）。
//
// 规格依据：specs/spec-screen-frame-handoff.md 第 4.1 节。
//   不变量违例在 Debug 下必须 abort（由死亡测试验证）；
//   在 Release 下必须只增加计数、不 abort（由计数用例验证）。
//
// 注意：Debug 与 Release 行为相反，因此同一个二进制里只能验证其中一种。
// 下面的用例按 #ifdef NDEBUG 分别编译，两种构建各自跑到对应的那一半。

#include <gtest/gtest.h>

#include <remotedesktop/assert.h>

#include <atomic>
#include <thread>
#include <vector>

namespace {

#if defined(NDEBUG)

  // ---- Release：断言降级为计数 ----

  TEST(AssertRelease, FailingAssertDoesNotAbort) {
    rd::reset_suppressed_assert_count();
    RD_ASSERT(1 == 2);  // 必须不死
    EXPECT_EQ(rd::suppressed_assert_count(), 1u);
  }

  TEST(AssertRelease, PassingAssertDoesNotCount) {
    rd::reset_suppressed_assert_count();
    RD_ASSERT(1 == 1);
    EXPECT_EQ(rd::suppressed_assert_count(), 0u);
  }

  TEST(AssertRelease, CountAccumulates) {
    rd::reset_suppressed_assert_count();
    for (int i = 0; i < 5; ++i) {
      RD_ASSERT(false);
    }
    EXPECT_EQ(rd::suppressed_assert_count(), 5u);
  }

  TEST(AssertRelease, ResetClearsCount) {
    RD_ASSERT(false);
    ASSERT_GT(rd::suppressed_assert_count(), 0u);
    rd::reset_suppressed_assert_count();
    EXPECT_EQ(rd::suppressed_assert_count(), 0u);
  }

  TEST(AssertRelease, CounterIsThreadSafe) {
    rd::reset_suppressed_assert_count();
    constexpr int kThreads = 4;
    constexpr int kPerThread = 1000;

    {
      std::vector<std::thread> workers;
      workers.reserve(kThreads);
      for (int i = 0; i < kThreads; ++i) {
        workers.emplace_back([] {
          for (int j = 0; j < kPerThread; ++j) {
            RD_ASSERT(false);
          }
        });
      }
      for (auto& worker : workers) {
        worker.join();
      }
    }

    EXPECT_EQ(rd::suppressed_assert_count(),
              static_cast<std::uint64_t>(kThreads) * kPerThread);
  }

#else  // Debug：断言 abort

  TEST(AssertDebug, PassingAssertIsSilent) {
    rd::reset_suppressed_assert_count();
    RD_ASSERT(1 == 1);
    RD_ASSERT_MSG(2 > 1, "should not print");
    EXPECT_EQ(rd::suppressed_assert_count(), 0u);
  }

  TEST(AssertDebug, FailingAssertAborts) {
    EXPECT_DEATH(RD_ASSERT(1 == 2), "RD_ASSERT failed");
  }

  TEST(AssertDebug, FailingAssertWithMessageAborts) {
    EXPECT_DEATH(RD_ASSERT_MSG(1 == 2, "frame timestamp went backwards"),
                 "frame timestamp went backwards");
  }

#endif  // NDEBUG

}  // namespace
