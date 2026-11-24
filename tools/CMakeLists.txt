# 仓库约束自检（不是业务测试）
#
# 把 docs/ 里的硬约束接进 CTest。任一违规都让 ctest --preset debug 失败，
# 从而让"AGENTS.md 的约束"具备执行力，而不只是散文。
#
#   arch.layers      docs/architecture/overview.md 5.1 依赖方向（DEP-01..05）
#                    + docs/architecture/threading.md 1 节线程归属（THREAD-01/02）
#
#   spec.structure  docs/increments/README.md 的索引、状态、规格章节和文档顺序

find_package(Python3 COMPONENTS Interpreter QUIET)

if(NOT Python3_Interpreter_FOUND)
  message(WARNING
    "未找到 Python3，spec.structure 和 arch.layers 将被跳过。"
    "请安装 Python 3 或设置 Python3_EXECUTABLE。")
else()
  add_test(
    NAME spec.structure
    COMMAND ${Python3_EXECUTABLE}
            ${PROJECT_SOURCE_DIR}/tools/check_specs.py
            --quiet)
  set_tests_properties(spec.structure PROPERTIES
    TIMEOUT 60
    WORKING_DIRECTORY ${PROJECT_SOURCE_DIR}
    LABELS "spec")

  add_test(
    NAME arch.layers
    COMMAND ${Python3_EXECUTABLE}
            ${PROJECT_SOURCE_DIR}/tools/check_layers.py)
  set_tests_properties(arch.layers PROPERTIES
    TIMEOUT 60
    WORKING_DIRECTORY ${PROJECT_SOURCE_DIR}
    LABELS "arch")
endif()
