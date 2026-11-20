# 约束目录（Constraint Catalog）

> L2（架构/约束审查层）引用的**唯一权威约束编号来源**。
> 每个编号映射到一个真实文档位置，并标注该约束是否已由 L0（`ctest` 确定性检查）覆盖。
> L2 的 verdict evidence 只能引用本表列出的编号；`spec-*` 验收用例引用 `specs/spec-*.md` 中的编号，格式 `spec-<file-stem>:<case-id>`。
>
> **L0/L2 分工原则**：能用确定性脚本（`grep`/静态扫描/退出码）判定的 → L0；需要理解语义、运行时行为或跨文件意图的 → L2。已被 L0 机械覆盖的编号，L2 **只检查其静态扫描看不到的形式**（如运行时依赖、回调式耦合），不重复报告 `#include` 层面的同类问题。

## 已由 L0（ctest）确定性覆盖的约束

以下编号由 `tools/check_layers.py`（CTest `arch.layers`）或 `tools/check_specs.py`（CTest `spec.structure`）**机械检查**。L2 对这些编号只看"静态扫描查不到的形式"。

| 编号 | 约束 | 来源 | L0 检查方式 | L2 仍需看的（静态查不到的） |
|---|---|---|---|---|
| `DEP-01` | `include/` 不得依赖 `src/` | architecture.md 5.1 | 扫描 `#include` 指向 `../src` | 运行时/链接层面的反向依赖 |
| `DEP-02` | 平台层不得依赖业务层 | architecture.md 5.1 | 扫描 `src/platform/` 内的业务头 `#include` | 回调/函数指针式耦合 |
| `DEP-03` | 同层模块不得互引 | architecture.md 5.1 | 扫描同层 `#include` | 类型传递/运行时互调 |
| `DEP-04` | 业务层不得直接调平台 API | architecture.md 5.1 | 扫描平台 SDK 头/符号 | 动态加载、字符串反射调用平台 API |
| `DEP-05` | `third_party/` 不得被修改 | architecture.md 5.1 | `git status third_party/` | —（L0 全覆盖） |
| `THREAD-01` | 每个 `.cpp` 文件头须有 `// Thread: <名>` 注释 | threading.md §1 | 正则检查文件头 | —（L0 全覆盖） |
| `THREAD-02` | `// Thread:` 取值须在白名单内 | threading.md §1 | 取值白名单比对 | —（L0 全覆盖） |
| `spec.structure` | 规格状态行/必需章节/编号用例/索引一致 | specs/README.md | `check_specs.py` | —（L0 全覆盖） |

## L2 专属约束（静态扫描查不到，需语义判断）

### 线程与交接（来源：docs/threading.md）

| 编号 | 约束 | 文档位置 | L2 判定要点 |
|---|---|---|---|
| `THREAD-03` | 线程数固定；不得按会话/设备新建线程或线程池；新增须先改文档并获批 | threading.md §1 | 搜索 `std::thread`/`jthread`/`pthread_create`/线程池构造点是否在白名单文件；新增线程是否同步改了本文 |
| `HANDOFF-1` | Capture→Encode 帧槽：容量=1，满则覆盖，绝不 wait/重试/反向流 | threading.md §2.1 | `publish()` 内有无 lock/wait/sleep/条件变量/malloc；容量是否 >1；有无 Encode→Capture 反向调用 |
| `HANDOFF-2` | Encode→Network 发送队列：按时间/字节预算，无同步回压，只异步信号 | threading.md §2.2 | Encode 线程有无 socket/TLS 调用；Network 有无阻塞等帧；队列是否用"帧数"而非字节预算 |
| `HANDOFF-3` | Network→Decode 接收队列：缺片不等补齐，丢帧并请求关键帧 | threading.md §2.3 | Network 线程有无解码/色彩转换；有无为缺片保留帧到超时 |
| `HANDOFF-4` | Decode→UI 最新帧：1–2 帧覆盖式，UI 慢=丢帧不堆积 | threading.md §2.4 | 渲染队列是否无界 vector/queue；UI 线程有无读 socket/解码/磁盘 I/O |
| `HANDOFF-5` | Network→Session 控制消息：Session 不阻塞等 Network 返回 | threading.md §2.5 | Session 执行器有无 socket 读写/`future.get()`/`wait()`；Network 是否直接改 Session 字段 |
| `HANDOFF-6` | Session→Input 授权门禁：门禁先于注入生效；Input 只上报事件不改会话状态 | threading.md §2.6 | Input 线程是否自己判断会话状态；`input_epoch` 是否在 Input 本地自增而非 Session 分配 |
| `HANDOFF-7` | Input→platform 注入：不阻塞等渲染/网络/下一帧；失败只返回错误 | threading.md §2.7 / platform-abstraction.md §4 | `inject()` 有无等待；每次按下是否记账，`release_all_pressed` 是否全释放 |
| `HANDOFF-8` | 任意线程→Writer 事件队列：不入队时拼字符串，满则丢弃不阻塞 | threading.md §2.8 | 热路径有无 string 拼接/printf/format/ofstream；队列满是否阻塞调用方 |
| `QUEUE-1` | 所有队列容量为编译期/配置期常量，有明确上限与溢出策略；热路径不扩容 | threading.md §3 | 新队列是否是可增长容器（deque/vector 作队列）；容量是否非常量；溢出是否有计数/可观测 |
| `LATENCY-1` | 端到端目标：局域网 <50ms（P95）、广域网 <150ms；单帧捕获周期 ≤33ms | threading.md §4.1 / AGENTS.md §6.2 | 改动是否影响捕获/编码/传输任一环却无测量数据支撑 |
| `LATENCY-2` | 阶段预算：采集≤6ms / 编码≤12ms / 传输≤10ms / 解码≤8ms / 渲染≤4ms；超限先确认口径再改架构，不得靠加缓冲掩盖 | threading.md §4.2 | 超限是否通过增大缓冲掩盖而非降级；是否改了预算却没改文档 |
| `HOTPATH-1` | Capture/Encode/Network/Decode/UI 关键路径禁止：同步文件 I/O/flush、日志字符串拼接、堆动态扩容、跨线程锁竞争、异常作控制流、每帧字符串解析、等其他线程返回值 | threading.md §4.3 | 热路径函数是否可能阻塞/分配/碰磁盘且无硬上限 |
| `SHUTDOWN-1` | 关闭顺序固定：先关输入授权门禁并释放按压 → 再停采集/解绑回调/关传输 → 最后等待在途任务退出、销毁资源 | architecture.md §5.3 / threading.md §2.6 | 关断顺序是否反了（先停采集后关门禁会留键在系统） |
| `T-01`..`T-09` | threading.md §5 评审清单九条 | threading.md §5 | 逐条核对；T-09 要求延迟改动附前后测量数据 |

### 平台抽象（来源：docs/platform-abstraction.md，status: draft）

| 编号 | 约束 | 文档位置 | L2 判定要点 |
|---|---|---|---|
| `PLAT-1` | 平台相关代码只在 `src/platform/{win,linux,mac}/`；`platform.h` 不含任何平台头文件 | platform-abstraction.md §1 | 业务/协议代码是否直接含平台 SDK 调用（DEP-04 覆盖头文件，L2 覆盖运行时/动态调用） |
| `PLAT-2` | 平台边界错误用 `std::expected<T, PlatformError>` 返回；禁止 `bool`+`errno` 或跨边界抛异常 | platform-abstraction.md §2 | 平台接口是否有抛异常跨边界、或返回 bool+errno 的形式 |
| `PLAT-3` | `acquire_frame` 是唯一阻塞点且必须尊重 timeout；超时返回 `kTimeout` 不无限等；不在采集路径做缩放/色彩转换/编码 | platform-abstraction.md §3 | 采集器是否持有帧引用；超时行为；有无在采集侧做格式转换 |
| `PLAT-4` | `inject()` 不阻塞等渲染/网络/下一帧，失败只返回错误；键值用项目自定义枚举不暴露平台虚拟键码 | platform-abstraction.md §4 / §4.1 | 注入器是否重复做业务判断（应由 Input 执行器做）；是否暴露平台键码 |
| `PLAT-5` | 非 `kInteractive` 桌面状态一律结束会话；`subscribe` 回调只投递事件不得阻塞/做业务判断 | platform-abstraction.md §5 | 回调内有无业务判断或阻塞；是否把 SSH/Session 0 当可采集桌面 |
| `PLAT-6` | `display_map_version` 单调递增；版本回退/不一致按 `kDisplayChanged` 处理，不得继续注入旧坐标 | platform-abstraction.md §6 | 版本回退是否静默适配而非重建 |
| `PLAT-7` | `RenderSurface::present` 不得保留引用到下次调用之后；UI 线程不读网络 | platform-abstraction.md §7 | present 是否持有 VideoFrame 引用越界 |

### 安全（来源：AGENTS.md §6.4、§8）

| 编号 | 约束 | 文档位置 | L2 判定要点 |
|---|---|---|---|
| `SEC-1` | 代码/日志/注释中禁止明文密钥、Token、密码 | AGENTS.md §6.4 | 搜索疑似硬编码凭据（不在 L0 机械范围时由 L2 语义判断） |
| `SEC-2` | 网络接收的所有外部输入视为不可信：长度校验、边界检查、错误码向上传播 | AGENTS.md §6.4 | 接收路径有无长度/边界校验；错误是否吞掉 |
| `SEC-3` | 捕获/编码路径禁止无界队列；队列须有明确上限和丢弃策略 | AGENTS.md §6.4 | 与 QUEUE-1 联动；热路径队列是否有界 |

### 规格一致性（来源：specs/spec-*.md）

| 编号格式 | 含义 | L2 判定要点 |
|---|---|---|
| `spec-<stem>:<case-id>` | 对应 `specs/spec-<stem>.md` 中编号的验收用例 | diff 是否实现/违反了该验收场景；先读 spec 再对照代码 |

当前已存在的规格文件（`spec-stem`）：
- `spec-screen-frame-handoff` — 帧移交契约（关联 HANDOFF-1）
- `spec-platform-win` — Windows 平台采集/注入契约（关联 PLAT-3/4）
- `spec-lan-vertical-slice` — 局域网纵向切片验收

## 给 L2 的使用指引

1. 先读本目录，确定当前 diff 触及哪些模块/线程，选出**相关**的约束子集，不要逐条全扫。
2. 引用编号必须是本表存在的 ID（或合法的 `spec-<stem>:<case-id>`）。引用本表不存在的 ID = 裁决不合规。
3. 对 L0 已覆盖的编号（DEP-01..05、THREAD-01/02、spec.structure），只在发现**静态扫描查不到的形式**时才报；普通 `#include`/文件头问题不报（L0 已拦）。
4. 不确定是否越界时，finding 标 `uncertain: true` + `severity: "suggestion"`，在 summary 注明"需人工复核"，不阻断流水线。
