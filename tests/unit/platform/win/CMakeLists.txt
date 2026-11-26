# Mock-backed platform tests. No Windows SDK or real desktop required.
# Thread: none
include(GoogleTest)

add_executable(platform_win_input_tests input_inject_win_test.cpp)
target_link_libraries(platform_win_input_tests PRIVATE rd_platform GTest::gmock_main)
gtest_discover_tests(platform_win_input_tests TEST_PREFIX "platform.win.input_inject.")

add_executable(platform_win_desktop_tests session_state_win_test.cpp)
target_link_libraries(platform_win_desktop_tests PRIVATE rd_platform GTest::gmock_main)
gtest_discover_tests(platform_win_desktop_tests TEST_PREFIX "platform.win.desktop_state.")

add_executable(platform_win_desktop_source_tests desktop_event_source_win_test.cpp)
target_link_libraries(platform_win_desktop_source_tests PRIVATE rd_platform GTest::gmock_main)
gtest_discover_tests(platform_win_desktop_source_tests TEST_PREFIX "platform.win.desktop_source.")
