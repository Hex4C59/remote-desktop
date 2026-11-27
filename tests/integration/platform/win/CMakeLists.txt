# Tests that require an unlocked, interactive Windows desktop.
# Thread: none
set(desktop_test_support "${PROJECT_SOURCE_DIR}/src/platform/win/test_support")
add_executable(platform_win_desktop_acceptance
  desktop_acceptance_test.cpp
  "${desktop_test_support}/desktop_fixture_win.cpp")
target_include_directories(platform_win_desktop_acceptance PRIVATE "${desktop_test_support}")
target_link_libraries(platform_win_desktop_acceptance PRIVATE rd_platform GTest::gtest gdi32 psapi user32)
gtest_discover_tests(platform_win_desktop_acceptance
  TEST_FILTER "DesktopAcceptance.Pwh*"
  TEST_PREFIX "integration.platform.win."
  PROPERTIES LABELS "windows-desktop" RUN_SERIAL TRUE TIMEOUT 240)
