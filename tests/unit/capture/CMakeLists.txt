# 捕获与帧移交的单元测试。
#
# 规格依据：docs/increments/002-screen-frame-handoff/spec.md 第 5 节。
# 当前批次：FH-01/02/06/07/08/23（单线程）。并发与其余死亡测试在后续批次加入。

add_executable(frame_handoff_tests frame_handoff_test.cpp)
target_link_libraries(frame_handoff_tests PRIVATE rd GTest::gtest_main)

include(GoogleTest)
gtest_discover_tests(frame_handoff_tests
  TEST_PREFIX "capture.frame_handoff."
  PROPERTIES TIMEOUT 60)
