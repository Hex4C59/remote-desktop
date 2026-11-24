# 核心公共设施的单元测试（当前只有断言机制）。
#
# 规格依据：docs/increments/002-screen-frame-handoff/spec.md 第 4.1 节、FH-10/FH-11/FH-15。
# 这些用例先于帧池实现存在，因为帧池的 Debug/Release 行为依赖断言宏。

add_executable(assert_tests assert_test.cpp)
target_link_libraries(assert_tests PRIVATE rd GTest::gtest_main)

include(GoogleTest)
gtest_discover_tests(assert_tests
  TEST_PREFIX "core.assert."
  PROPERTIES TIMEOUT 60)
