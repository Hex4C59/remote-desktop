# 远程桌面 —— 顶层构建入口
# 约束见 AGENTS.md：C++20、CMake ≥ 3.28 + Ninja、GoogleTest/GoogleMock 经 CTest 驱动。
# 验证回路：cmake --preset debug / cmake --build --preset debug / ctest --preset debug

cmake_minimum_required(VERSION 3.28)

project(remote_desktop
  VERSION 0.1.0
  DESCRIPTION "跨平台 C++ 远程桌面"
  LANGUAGES CXX)

# ---------------------------------------------------------------------------
# 语言与编译选项
# ---------------------------------------------------------------------------

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(RD_WARNINGS_AS_ERRORS "把编译器警告当作错误（CI 与本地验证默认开启）" ON)

add_library(rd_compile_options INTERFACE)
target_compile_features(rd_compile_options INTERFACE cxx_std_20)

if(MSVC)
  target_compile_options(rd_compile_options INTERFACE /W4 /permissive- /utf-8 /Zc:__cplusplus)
  if(RD_WARNINGS_AS_ERRORS)
    target_compile_options(rd_compile_options INTERFACE /WX)
  endif()
else()
  target_compile_options(rd_compile_options INTERFACE
    -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wsign-conversion)
  if(RD_WARNINGS_AS_ERRORS)
    target_compile_options(rd_compile_options INTERFACE -Werror)
  endif()
endif()

# ---------------------------------------------------------------------------
# 第三方依赖
#
# 依赖引入方式固定在这里，不在各处零散 FetchContent。新增依赖须先改本文件与
# AGENTS.md §3，并说明版本与来源。
#   - 网络可达时从 RD_GTEST_REPOSITORY 的固定 tag 拉取（commit 由 tag 锁定）。
#   - 无法联网时，把源码放到 RD_GTEST_SOURCE_DIR 指向的目录（或设 -DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=...）。
# ---------------------------------------------------------------------------

include(FetchContent)

set(RD_GTEST_REPOSITORY "https://gitee.com/mirrors/googletest.git" CACHE STRING
    "GoogleTest 源码仓库；默认使用可达的镜像")
set(RD_GTEST_TAG "v1.18.0" CACHE STRING "GoogleTest 固定 tag")

if(BUILD_TESTING)
  FetchContent_Declare(googletest
    GIT_REPOSITORY "${RD_GTEST_REPOSITORY}"
    GIT_TAG        "${RD_GTEST_TAG}"
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   TRUE)

  # GoogleTest 自身不参与本项目的警告策略与安装规则。
  set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(googletest)

  include(GoogleTest)
endif()

# CTest 始终启用：规格结构自检与 BUILD_TESTING 无关。
enable_testing()

# ---------------------------------------------------------------------------
# 源码
#
# 当前只有库骨架，没有任何业务实现。模块按 docs/architecture.md 第 5 节逐步加入；
# 加入时在此处显式 add_subdirectory，不使用文件通配。
# ---------------------------------------------------------------------------

add_subdirectory(src)

if(BUILD_TESTING)
  add_subdirectory(tests)
endif()

# 规格结构自检：把 specs/README.md 的约定变成 CTest 用例。
# 放在 BUILD_TESTING 之外，因为“规格先于代码”与是否构建测试无关。
add_subdirectory(specs)

# 仓库约束自检：docs/ 里的分层与线程归属规则。
add_subdirectory(tools)
