# AGENTS.md

> 本文件是 AI 协作的强制约束，不是建议。任何代码变更必须首先满足本文件中的硬性规则。
> 详细架构文档见 `docs/architecture/overview.md`，远程桌面协议细节见 `docs/protocol/README.md`。

## 1. 项目一句话

跨平台 C++ 远程桌面软件。Server 捕获屏幕并注入输入，Client 渲染画面并发送控制事件。
目标：低延迟、高帧率、输入跟手。延迟预算与线程模型是**一等公民**，不得为了功能牺牲延迟。

## 2. 构建与验证（Commands first）

```bash
# 配置（必须用 CMake Presets，禁止裸 cmake）
cmake --preset debug

# 构建（默认开启 RD_WARNINGS_AS_ERRORS=ON，零警告通过）
cmake --build --preset debug -j

# 全量测试（提交前必须全部通过）
ctest --preset debug --output-on-failure

# 只跑某个模块的测试（示例：capture 模块）
ctest --preset debug -R capture --output-on-failure
```

涉及 `NDEBUG` 或 `RD_ASSERT` 降级行为时，同步使用 `release` 预设验证（`cmake --preset release && cmake --build --preset release -j && ctest --preset release --output-on-failure`）。

**硬性规则：**
- 任何“完成”的声明，必须附上上述测试命令的通过输出摘要。没有跑过测试，不得声称完成。
- 禁止通过削弱断言、缩小测试范围、跳过测试来获得“通过”。

**约束自检：** `ctest` 包含两个非业务用例，把文档里的硬约束变成可执行检查：

| 用例 | 依据 | 检查内容 |
|---|---|---|
| `spec.structure` | `docs/increments/README.md` | 增量编号、规格章节、验收编号、索引状态和文档顺序 |
| `arch.layers` | `docs/architecture/overview.md` 5.1、`docs/architecture/threading.md` 第 1 节 | 依赖方向（DEP-01..05）、线程归属注释（THREAD-01/02） |

单独跑：`ctest --preset debug -R "spec.structure|arch.layers" --output-on-failure`。
这两条不通过，说明代码或规格已偏离文档所述约束，不得声称完成。

## 3. 技术栈与工具链锁定

| 项 | 锁定值 |
|---|---|
| C++ 标准 | C++20 |
| 编译器 | Clang 17+ / GCC 13+ / MSVC 19.38+ |
| 构建系统 | CMake ≥ 3.28 + Ninja |
| 测试框架 | GoogleTest + GoogleMock（通过 CTest 驱动） |
| 平台抽象 | 平台相关代码置于 `src/platform/{win,linux,mac}/`，核心逻辑通过平台接口调用 |

新增平台目录（如 `src/platform/android/`）及对应的独立构建工具链须经对应增量规格获批后启用，当前各平台增量的审批状态见 [增量索引](docs/increments/README.md)；仓库根目录始终以 CMake Presets 为主回归入口。

**禁止：** 未经明确批准引入新的第三方依赖。`third_party/` 中的外部依赖代码不得修改。

## 4. SDD：规格先行

**核心原则：没有获批的规格，不写功能性代码。**

- 每个增量在 `docs/increments/<NNN>-<slug>/` 下登记，`spec.md`、`plan.md` 和 `tasks.md` 放在同一目录。
- 新增或变更功能按 **规格 → 技术方案 → 任务 → TDD → 验收证据** 推进；实施前须有 `status: approved` 规格。实施者不得自行把规格改成 `approved`，须由用户确认。
- 规格必须包含**接口约定**（类型、错误码、线程归属）、**不变量**和**编号验收场景**。规格上线后继续锚定行为，实现中发现需要变更时先改规格再改代码。
- 提出规格变更建议时，必须完整说明接口全貌（含既有声明上下文）、不变量与错误路径、线程归属、验收场景编号和受影响的现有条款；禁止只给“最小补充”片段。

**路由规则：**
- 新功能 / 行为变更 / 架构变更 → 先写或改规格、方案与任务，规格获批后再进入 TDD。
- Bug 修复（行为不变）→ 先写**失败测试**复现问题；若根因涉及架构或接口变更，同步补规格。

完整操作序列见 [`.agents/skills/sdd-loop/SKILL.md`](.agents/skills/sdd-loop/SKILL.md)，增量索引与模板见 [增量索引](docs/increments/README.md)。

## 5. TDD：红 → 绿 → 重构

使用 GoogleTest/GoogleMock，严格执行 **定义接口 → 写失败测试（RED）→ 最小实现（GREEN）→ 重构**：

- 编译失败或环境错误不算红灯，必须亲眼确认目标断言因缺少行为而失败。
- 目标用例变绿后，交付前必须跑全量测试套件。
- 完整操作步骤与自检清单见 [`.agents/skills/tdd/SKILL.md`](.agents/skills/tdd/SKILL.md)，按改动选择用例与验收记录规范见 [测试与验收](docs/verification/README.md)。

**测试放置约定：**
- 单元测试与源文件同目录或 `tests/unit/`，按模块镜像。
- 集成测试（涉及捕获 → 编码 → 传输链路）放在 `tests/integration/`。
- Mock 平台 API，不得在单元测试中依赖真实屏幕或真实网络。

## 6. 远程桌面特有的硬性工程约束

### 6.1 线程模型（不得随意改动）

以下线程划分是架构决策，线程数固定，不按会话创建新线程，未经架构评审不得改变（完整规则与交接边沿见 `docs/architecture/threading.md`）：

- **Capture 线程**：只负责捕获并移交至单帧槽，**不得编码、网络 I/O 或阻塞等待**。
- **Encode 线程**：独立编码，与 Capture 通过无锁单槽解耦，不得等待网络或 UI。
- **Network 线程**：负责收发、分片重组、加密与保活，不得阻塞在编解码或 UI 上。
- **UI 线程（控制端）**：只做窗口渲染和输入事件采集，不得直接网络读取或解码。
- **其余固定线程/串行执行器**：**Session**（会话状态、授权门禁、代次）、**Input**（输入队列与注入调度）、**Decode**（控制端解码）、**Writer**（可选，统计与证据异步写盘）。

**判定标准：** 如果打算新开线程、新增线程池或跨边界加锁，先停下来检查是否破坏上述边界；破坏边界必须先改 `docs/architecture/threading.md` 与规格并取得批准。

### 6.2 延迟预算

- 端到端目标：局域网内 **< 50 ms**，广域网内 **< 150 ms**（以规格中的场景定义为准）。
- 帧捕获周期硬上限参考值：**33 ms（30 FPS）**；编码不得让单帧总处理时间超过捕获周期。
- Capture / Encode / Network 热路径上**硬禁止**同步 I/O、动态内存分配与日志字符串拼接；其他可能影响延迟的改动（如额外拷贝、锁或等待），必须在交付说明或验收记录中附实测延迟数据，无数据不得进入热路径。

### 6.3 输入注入的边界

- Server 端输入注入只调用 `src/platform/` 下封装的接口，**禁止在业务逻辑中直接调用 `SendInput`、`XTestFake*` 等平台 API**。
- 注入的事件必须携带时间戳和来源标识，便于排查“输入延迟/错乱”问题。
- 涉及键盘/鼠标钩子的代码必须有单元测试覆盖事件过滤逻辑；钩子安装/卸载必须有集成测试或明确的运行时检查。

### 6.4 安全与资源

- **禁止**在代码、日志、注释中写入明文密钥、Token、密码。
- 网络接收路径上的所有外部输入必须被视为不可信：长度校验、边界检查、错误码向上传播。
- 捕获和编码路径上禁止无界队列；队列必须有明确的上限和丢弃策略。

## 7. 代码约定（C++ 特有）

- 头文件放 `include/`（公共）或与源文件同目录（私有）；源文件放 `src/`。
- 代码格式遵循仓库 [.clang-format](.clang-format)（如命名空间内缩进 2 空格、不跨块重排 `#include`）。
- 智能指针优先；裸 `new/delete` 仅允许在极少数明确标注所有权转移的边界出现，且必须封装。
- 公共接口的错误传递方式由规格定义（错误码或基于 `std::variant` 的结果类型，如 `PlatformResult<T>`），**不得在同一模块内混用异常和错误码**。
- 命名：类型 `PascalCase`，函数/变量 `snake_case`，成员变量后缀 `_`，常量 `kPascalCase`。
- 标准库优先使用 C++ 设施：输出用 `<iostream>`，不引入 `printf`/`scanf` 家族；C 兼容头一律用 `<c...>`（如 `<cstdint>`、`<cstdlib>`、`<cstddef>`），不用 `<...h>`。确需 C 接口（与系统 API 对接）时在调用处注释理由。
- 每个新文件必须有简短的文件头注释，说明职责与线程归属，格式严格为 `// Thread: <线程名>`（如 `// Thread: capture`，合法取值见 `docs/architecture/threading.md` 第 1 节，供 `arch.layers` 自动校验）。

## 8. 禁止事项（违反即回退）

- 禁止修改 `third_party/`。
- 禁止在 Capture/Encode/Network 热路径上引入同步 I/O、动态内存分配或日志字符串拼接。
- 禁止用“临时绕过”替代规格更新：任何绕过接口约定的 `friend`、全局变量、`#define private public` 都不得进入主分支。
- 禁止在没有失败测试的情况下修复 Bug。
- 禁止声称“完成”而不贴测试输出。
- 禁止修改平台抽象层的公共接口而不更新 `docs/architecture/platform-abstraction.md`。

## 9. 文档索引（需要细节时读这些）

| 文档 | 内容 |
|---|---|
| `docs/README.md` | 文档导航 |
| `docs/architecture/overview.md` | 整体分层、依赖方向（含 DEP-01..05 判定规则）、模块职责、数据流 |
| `docs/protocol/README.md` | 协议消息格式、消息类型、版本兼容 |
| `docs/architecture/threading.md` | 线程模型、交接边沿判定规则、队列策略、延迟预算、评审清单 |
| `docs/architecture/platform-abstraction.md` | 平台接口的调用条件、返回结果、错误码和线程要求 |
| `docs/increments/README.md` | 增量索引、模板、审批状态与自动校验 |
| `docs/increments/` | 各增量的规格、计划和任务 |
| `docs/verification/README.md` | 按改动选择目标用例、属性测试与验收证据记录约定 |
| `tests/` | 测试源码目录（单元测试与冒烟测试） |

## 10. 文档用语

编写或修改文档前，先读 [文档写作示例](docs/writing-guide.md)。

- 用目标读者能理解的话写标题、链接文字和正文。把只有熟悉项目的人才懂的简称、内部叫法和抽象分类改成具体的设备、操作、结果或验收条件。
- 需要准确引用协议、接口、错误码或工具时，保留正式名称。首次出现时，用一句日常语言说明它在当前场景中做什么。
- 写完后，检查读者能否仅凭标题和链接文字判断这一节讲什么，再检查正文是否说清谁做什么、会看到什么结果。
