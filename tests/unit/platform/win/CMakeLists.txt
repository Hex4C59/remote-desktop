# Mock-backed platform tests. No Windows SDK or real desktop required.
# Thread: none
include(GoogleTest)

add_executable(platform_win_input_tests input_inject_win_test.cpp)
target_link_libraries(platform_win_input_tests PRIVATE rd_platform GTest::gmock_main)
gtest_discover_tests(platform_win_input_tests TEST_PREFIX "platform.win.input_inject.")

add_executable(platform_win_capture_tests screen_capture_win_test.cpp)
target_link_libraries(platform_win_capture_tests PRIVATE rd_platform GTest::gmock_main)
gtest_discover_tests(platform_win_capture_tests TEST_PREFIX "platform.win.screen_capture.")

add_executable(platform_win_desktop_tests session_state_win_test.cpp)
target_link_libraries(platform_win_desktop_tests PRIVATE rd_platform GTest::gmock_main)
gtest_discover_tests(platform_win_desktop_tests TEST_PREFIX "platform.win.desktop_state.")

add_executable(platform_win_desktop_source_tests desktop_event_source_win_test.cpp)
target_link_libraries(platform_win_desktop_source_tests PRIVATE rd_platform GTest::gmock_main)
gtest_discover_tests(platform_win_desktop_source_tests TEST_PREFIX "platform.win.desktop_source.")

add_executable(platform_win_capture_memory_budget_tests
  capture_memory_budget_test.cpp
  "${PROJECT_SOURCE_DIR}/tests/integration/platform/win/capture_memory_budget.cpp"
)
target_include_directories(platform_win_capture_memory_budget_tests PRIVATE
  "${PROJECT_SOURCE_DIR}/tests/integration/platform/win"
)
target_link_libraries(platform_win_capture_memory_budget_tests PRIVATE
  rd_platform GTest::gtest_main
)
gtest_discover_tests(platform_win_capture_memory_budget_tests
  TEST_PREFIX "platform.win.capture_memory_budget."
)

find_package(Python3 REQUIRED COMPONENTS Interpreter)
add_test(NAME platform.win.capture_resource_report
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/capture_resource_report_test.py")
add_test(NAME platform.win.capture_acceptance_batch
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/capture_acceptance_batch_test.py")
