# 源码入口
#
# 模块按 docs/architecture.md 第 5 节逐个加入，每个模块在自己的目录里定义目标。
# 当前内容：公共头文件 + 断言实现（供规格 FH-10/FH-11/FH-15 使用）。
#
# 目标命名与目录对应关系（后续加入时保持）：
#   rd_platform   src/platform
#   rd_capture    src/capture
#   rd_codec      src/codec
#   rd_transport  src/transport
#   rd_session    src/session
#   rd_input      src/input
#   rd_telemetry  src/telemetry

# 核心库：公共头文件的实现。目前只有断言计数。
# 后续模块作为独立目标加进来，并按 docs/architecture.md 5.1 的依赖方向连接。
add_library(rd STATIC
  assert.cpp)
target_include_directories(rd PUBLIC
  $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>)
target_link_libraries(rd PUBLIC rd_compile_options)

# 公共头文件在每次构建时被真实编译一次：头文件写坏了立刻暴露，
# 不需要等到某个源文件偶然包含它。
add_library(rd_headers STATIC headers_check.cpp)
target_link_libraries(rd_headers PRIVATE rd)
