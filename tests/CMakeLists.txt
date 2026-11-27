# 测试入口
#
# 组织方式见 AGENTS.md §5、docs/architecture/threading.md §5：
#   tests/unit/<模块>/      与 src/<模块> 镜像，用 mock 平台接口
#   tests/integration/      跨线程/跨模块链路
#   tests/smoke/            构建与验证回路自检
#
# 约定：每个可执行测试目标都必须接 gtest_discover_tests()，否则 CTest 看不到用例。
# ctest -R <名字> 通过目标名前缀定位，例如 ctest --preset debug -R smoke。

add_subdirectory(smoke)
add_subdirectory(unit/core)
add_subdirectory(unit/capture)
add_subdirectory(unit/platform/win)

option(RD_WINDOWS_DESKTOP_TESTING "构建需要本机交互桌面的验收程序" OFF)
if(WIN32 AND RD_WINDOWS_DESKTOP_TESTING)
  add_subdirectory(integration/platform/win)
endif()
