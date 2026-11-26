# 001 实施方案 · Android 手机在局域网远控 Windows 电脑

## 规格与工程约束

依据 [001 规格](spec.md) 的 M1 范围和验收场景。首发组合为 Android 控制端与 Windows 被控端。
根目录 C++20 回归使用 `debug` preset。Android 使用 [007](../007-android-controller/plan.md) 的 Gradle Wrapper 与 NDK/CMake 装配。
M1 的共用线程交接遵循 001 §2.5 与[线程模型 §2.9](../../architecture/threading.md#29-m1-会话交接)。Android 控制端的线程映射随 007 评审。
新增依赖按仓库规则审批。各项功能依次评审规格，获批后进入 TDD。

## 模块与数据流

| 模块 | 工作与接口 |
| --- | --- |
| Transport | 区分配对和远控模式。控制、媒体和输入统一校验认证连接归属。Network 校验有效 `input.pause` 后写入独立接收槽，Session 将其与普通控制消息按接收顺序归并。暂停或其应答无法入队时，经独立关断槽结束会话。详见[控制协议](../../protocol/README.md) |
| Session / UI / Writer | Session 管理质询、待决授权和活动槽位。本机批准前的拒绝或超时释放预留槽位。批准后因媒体拒绝、断线或首帧超时退出时进入 `kEnding`，等已启动资源退出和按压清理确认才释放槽位。配对时 Session 串行裁决取消与最终提交许可，Writer 返回带尝试 ID 的结果，UI 按本端实际登记状态显示结果 |
| Input / Windows 平台 | Session 独占门禁开启权。桌面回调按会话代次在与单次许可共用的原子状态上封闭门禁，再通过独立槽通知 Session。Input 按实际效果记账，普通注入返回错误后在领取下一条事件前封闭门禁、作废积压输入并请求关断。Input 经本地释放路径清理。详见 [003](../003-platform-win/spec.md) |
| Windows Capture / Encode | Capture 将初始映射通知 Session，由 `media.offer` 传递 `display_map_version`。映射变化时 Capture 停止发布，Session 关闭门禁并结束会话。关断时 Encode 消费剩余帧并异步确认，工作线程跨会话复用 |
| Android Decode / UI | Decode 用系统编解码器向当前 Surface 呈现 H.264。UI 管理表面与触控，Session 核验首帧回执和输入代次。详见 [007](../007-android-controller/spec.md) |
| Telemetry | 采集队列、门禁关断与媒体阶段证据，记录本地单调时钟及统计覆盖率，按 001 §4 保存原始测量路径 |

## 技术决策与风险

- 传输规格须选择经验证的 PAKE 和标准双向认证方案，并为单 UDP 关联内的控制、视频和输入给出完整安全及资源边界。
- 两端独立持久化。取消先于提交许可时清除暂存，许可先于取消且写入成功时保留本端记录。控制端收到 `pair.complete` 且本地激活后显示成功。单边提交时允许同一身份重新现场确认并幂等补齐。
- 门禁的原子封闭是通知与注入许可交错的判定点。许可先取得时，Input 只完成该次普通调用，按结果记账后清理。初始桌面状态未知或订阅失败时保持门禁关闭。
- 002 的清槽接口用于端点退出。会话切换通过停止发布与正常消费清空帧槽。

## 实施顺序

| 波次 | 交付与检查点 |
| --- | --- |
| 1 · 平台 | 评审 [007 Android 控制端](../007-android-controller/spec.md)，沿用 [003](../003-platform-win/spec.md)、[005](../005-windows-desktop-state/spec.md) 的 Windows 被控端能力和已有验证。对应 T001–T002 |
| 2 · 连接、授权与仅查看 | T003–T004 定稿并实现认证与本机授权。随后由 T007 接入 Windows 采集、编码与 007 的 Android 解码、呈现，用 `view` 会话验证首帧和退出 |
| 3 · 输入与关断 | T005–T006 落地输入代次和清理，依赖仅查看检查点接入 007 的触控、键盘及暂停恢复 |
| 4 · 真机联调及验收 | T008 用 Android 和 Windows 真机验证改分辨率后的关闭和重连，运行性能和长稳场景。[006](../006-windows-render-surface/spec.md) 提供后续 Windows 控制端路径 |

## 验证与交付

功能测试先记录失败断言，再记录目标用例与 Debug 全量 CTest 的通过结果。并发用例用 mock 和同步点控制事件顺序，分别覆盖门禁先封闭和许可先取得。构建和测试命令见 001 §6。

Android 和 Windows 真机验收覆盖 M1H-01–06。M1H-04 按 001 §4.2 分别记录设备、实际局域网链路、每类操作反馈、帧率、首帧和覆盖率。M1H-06 用手机保持远端鼠标按钮按下，在 Windows 更改分辨率，记录旧会话关断、释放确认与新会话点击结果。

在 `test-results/m1/` 按验收编号归档测试输出、双机环境、计时判定点、原始数据和结论。逐项回填[任务清单](tasks.md)。
