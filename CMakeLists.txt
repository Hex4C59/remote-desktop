cmake_minimum_required(VERSION 3.28)
project(remote_desktop LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "The desktop probe requires a Windows SDK and Windows runtime.")
endif()

add_executable(windows_desktop_probe probes/windows_desktop.cpp)
target_compile_features(windows_desktop_probe PRIVATE cxx_std_20)
target_compile_definitions(windows_desktop_probe PRIVATE UNICODE _UNICODE NOMINMAX)
target_link_libraries(windows_desktop_probe PRIVATE d3d11 dxgi)
if(MSVC)
    target_compile_options(windows_desktop_probe PRIVATE /W4 /permissive- /utf-8)
endif()
