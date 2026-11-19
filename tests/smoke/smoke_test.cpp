// 职责：验证构建与测试回路本身（CMake Presets → GoogleTest → CTest）。
// 线程归属：无（单线程、无平台调用）。
//
// 本文件不引入任何业务逻辑。它一旦失败，说明工具链或测试接线出了问题，
// 而不是被测功能有问题。

#include <gtest/gtest.h>

#include <remotedesktop/version.h>

#include <string>
#include <vector>

namespace {

// 编译期确认工具链按 C++20 生效。若 preset 里的标准被改回旧版本，这里先报错。
static_assert(__cplusplus >= 202002L, "项目要求 C++20（CMakePresets.json 中 CMAKE_CXX_STANDARD=20）");

TEST(Smoke, BuildsAndRuns) {
  EXPECT_EQ(2 + 2, 4);
}

TEST(Smoke, Cxx20IsActive) {
  EXPECT_GE(__cplusplus, 202002L);
}

TEST(Smoke, GoogleTestIsLinked) {
  // 用一点 std 容器与字符串，确认标准库头文件与运行时链接正常。
  const std::vector<std::string> parts{"remote", "desktop"};
  std::string joined;
  for (const auto& part : parts) {
    joined += part;
  }
  EXPECT_EQ(joined, "remotedesktop");
}

TEST(Smoke, CompilerIdentityIsRecorded) {
#if defined(_MSC_VER)
  constexpr const char* kCompiler = "MSVC";
#elif defined(__clang__)
  constexpr const char* kCompiler = "Clang";
#elif defined(__GNUC__)
  constexpr const char* kCompiler = "GCC";
#else
  constexpr const char* kCompiler = "unknown";
#endif
  RecordProperty("compiler", kCompiler);
  EXPECT_STRNE(kCompiler, "unknown");
}

TEST(Smoke, PublicHeaderIsUsable) {
  // 证明 include/ 已在测试目标的搜索路径上，且公共头能独立使用。
  EXPECT_EQ(rd::kAbiVersion, 1u);
  const rd::SessionId session = 7;
  const rd::InputEpoch epoch = 1;
  EXPECT_NE(session, 0u);
  EXPECT_EQ(epoch, 1u);
}

}  // namespace
