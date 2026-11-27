# Platform adapters and their mockable boundaries.
# Thread: none
add_library(rd_platform STATIC
  win/desktop_event_source_win.cpp
  win/input_inject_win.cpp
  win/screen_capture_win.cpp
  win/session_state_win.cpp)
target_link_libraries(rd_platform PUBLIC rd)

if(WIN32)
  target_sources(rd_platform PRIVATE
    win/desktop_duplication_win.cpp
    win/desktop_signals_win.cpp
    win/input_system_win.cpp)
  target_link_libraries(rd_platform PRIVATE d3d11 dxgi dxguid shcore user32 wtsapi32)
  if(RD_WINDOWS_CAPTURE_DIAGNOSTICS)
    target_compile_definitions(rd_platform PRIVATE RD_WINDOWS_CAPTURE_DIAGNOSTICS=1)
  endif()
endif()
