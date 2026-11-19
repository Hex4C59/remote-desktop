# 规格结构自检
#
# 把 specs/README.md 的约定接进 CTest：规格状态行、必需章节、编号用例、索引一致性
# 任何一项不合规，ctest --preset debug 就失败。这样"规格先于代码"不靠人记，靠构建拦。
#
# 这不是业务测试，不占业务测试的命名空间（前缀 spec.）。

find_package(Python3 COMPONENTS Interpreter QUIET)

if(NOT Python3_Interpreter_FOUND)
  message(WARNING
    "未找到 Python3，specs/ 结构自检将被跳过。"
    "请安装 Python 3 或设置 Python3_EXECUTABLE，否则 ctest 不覆盖规格检查。")
else()
  add_test(
    NAME spec.structure
    COMMAND ${Python3_EXECUTABLE}
            ${PROJECT_SOURCE_DIR}/tools/check_specs.py
            --quiet)
  set_tests_properties(spec.structure PROPERTIES
    TIMEOUT 60
    WORKING_DIRECTORY ${PROJECT_SOURCE_DIR}
    FIXTURES_REQUIRED ""
    LABELS "spec")
endif()
