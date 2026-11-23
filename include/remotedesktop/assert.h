// 职责：项目统一的断言宏。
// 线程归属：无（编译期与宏，可在任何线程使用）。
//
// 为什么不用裸 assert：
//   热路径上的不变量违例（例如帧时间戳回退）在 Debug 下要立刻暴露，
//   但在 Release 下不能因为单帧异常就 abort——远程桌面崩溃比丢帧严重。
//   因此 Release 下降级为"记一次计数后继续"，由遥测上报。
//
// 用法：
//   RD_ASSERT(cond);                    // Debug: abort；Release: 计数 +1
//   RD_ASSERT_MSG(cond, "detail");      // 同上，Release 下消息不作为字符串拼接
//   RD_ASSERT_COUNT();                  // 返回累计抑制次数，供测试与遥测读取
//
// 禁止在宏参数里写有副作用的表达式：Release 构建下参数不求值。

#pragma once

#include <cstdint>

namespace rd {
  // 断言被抑制（Release 下不成立）的累计次数。
  // 原子访问，可在任意线程调用。
  [[nodiscard]] std::uint64_t suppressed_assert_count() noexcept;

  // 供测试重置计数，以及遥测取走增量后归零。
  void reset_suppressed_assert_count() noexcept;
}  // namespace rd

namespace rd::detail {
  // 仅供 RD_ASSERT 宏使用，业务代码不得直接调用。
  void bump_suppressed_assert() noexcept;
}  // namespace rd::detail

#ifndef NDEBUG

#include <cstdio>
#include <cstdlib>

#define RD_ASSERT(cond)                                                       \
  do {                                                                        \
    if (!(cond)) {                                                            \
      std::fprintf(stderr, "RD_ASSERT failed: %s (%s:%d)\n", #cond, __FILE__, \
                   __LINE__);                                                 \
      std::abort();                                                           \
    }                                                                         \
  } while (false)

#define RD_ASSERT_MSG(cond, msg)                                         \
  do {                                                                   \
    if (!(cond)) {                                                       \
      std::fprintf(stderr, "RD_ASSERT failed: %s | %s (%s:%d)\n", #cond, \
                   (msg), __FILE__, __LINE__);                           \
      std::abort();                                                      \
    }                                                                    \
  } while (false)

#else  // NDEBUG

#define RD_ASSERT(cond)                       \
  do {                                        \
    if (!(cond)) {                            \
      ::rd::detail::bump_suppressed_assert(); \
    }                                         \
  } while (false)

#define RD_ASSERT_MSG(cond, msg) RD_ASSERT(cond)

#endif  // NDEBUG
