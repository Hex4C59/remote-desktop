# 验证回路自检
#
# 这个目标存在的唯一目的：证明「CMake Presets + GoogleTest + CTest」这条回路本身可用。
# 它不测业务行为。业务用例放到 tests/unit 或 tests/integration。
#
# 命名前缀 smoke_ 让 ctest -R smoke 只跑这一组，作为提交前的最快确认。

add_executable(smoke_tests smoke_test.cpp)
target_link_libraries(smoke_tests PRIVATE rd GTest::gtest_main)

include(GoogleTest)
gtest_discover_tests(smoke_tests
  TEST_PREFIX "smoke."
  PROPERTIES TIMEOUT 30)
