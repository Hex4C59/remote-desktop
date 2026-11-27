# Tests that require an unlocked, interactive Windows desktop.
# Thread: none
set(desktop_test_support "${PROJECT_SOURCE_DIR}/src/platform/win/test_support")
add_executable(platform_win_desktop_acceptance
  desktop_acceptance_test.cpp
  capture_measurement.cpp
  capture_memory_budget.cpp
  "${desktop_test_support}/desktop_fixture_win.cpp")
target_include_directories(platform_win_desktop_acceptance PRIVATE "${desktop_test_support}")
target_link_libraries(platform_win_desktop_acceptance PRIVATE rd_platform GTest::gtest gdi32 psapi user32)
gtest_discover_tests(platform_win_desktop_acceptance
  TEST_FILTER "DesktopAcceptance.Pwh*-DesktopAcceptance.Pwh07*:DesktopAcceptance.Pwh08*"
  TEST_PREFIX "integration.platform.win."
  PROPERTIES LABELS "windows-desktop" RUN_SERIAL TRUE TIMEOUT 240)
gtest_discover_tests(platform_win_desktop_acceptance
  TEST_FILTER "DesktopAcceptance.Pwh07*"
  TEST_PREFIX "integration.platform.win."
  PROPERTIES LABELS "windows-capture-stability" RUN_SERIAL TRUE TIMEOUT 900)

if(RD_WINDOWS_CAPTURE_DIAGNOSTICS)
  target_sources(platform_win_desktop_acceptance PRIVATE
    "${desktop_test_support}/capture_resource_diagnostics_win.cpp")
  target_compile_definitions(platform_win_desktop_acceptance PRIVATE
    RD_WINDOWS_CAPTURE_DIAGNOSTICS=1)
  target_link_libraries(platform_win_desktop_acceptance PRIVATE dxgi dxguid)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  find_program(RD_CDB_EXECUTABLE NAMES cdb.exe cdb
    HINTS "C:/Program Files (x86)/Windows Kits/10/Debuggers/x64"
    REQUIRED)
  add_test(NAME integration.platform.win.Pwh08NativeResourcesReleased
    COMMAND "${Python3_EXECUTABLE}"
      "${CMAKE_CURRENT_SOURCE_DIR}/run_capture_resources.py"
      --executable "$<TARGET_FILE:platform_win_desktop_acceptance>"
      --cdb "${RD_CDB_EXECUTABLE}"
      --output-dir "${PROJECT_SOURCE_DIR}/test-results/platform-win/pwh08-runs")
  set_tests_properties(integration.platform.win.Pwh08NativeResourcesReleased
    PROPERTIES LABELS "windows-capture-diagnostics" RUN_SERIAL TRUE TIMEOUT 240)
endif()
