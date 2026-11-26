# 测试与验收

改动开始时按下表选择目标用例。功能验收沿用各增量 `spec.md` 的编号，`tasks.md` 记录计划覆盖，实际命令和结果写入 `test-results/`。目标用例用于确认红灯和绿灯，交付时按协作规则运行全量 Debug 套件。 [协作规则](../../AGENTS.md)

## 按改动选择验证

| 改动范围 | 目标用例或验收编号 | 核对内容 |
| --- | --- | --- |
| 增量索引、规格、方案、任务 | `spec.structure` | 文档结构、审批状态和索引一致性 |
| 模块依赖、线程归属 | `arch.layers` | 分层依赖和线程归属声明 |
| CMake、测试接线、公共头文件 | `smoke.*` | 测试可发现、可运行，公共头文件可用 |
| `RD_ASSERT` 或依赖其行为的代码 | Debug `core.assert.AssertDebug.*`、Release `core.assert.AssertRelease.*` | Debug 终止行为与 Release 计数行为 |
| 帧池、单槽移交、帧写入视图 | `capture.frame_handoff.*`，见下表 | 两个构建配置中的帧所有权和写入约束 |
| Android 投屏授权、生命周期、像素和尺寸处理 | `AC-01`～`AC-08` | 按 Android 任务清单执行自动化用例 |
| Android 被控端候选 APK | `ACH-01`～`ACH-04` | 按 004 在 Android 14+ ARM64 真机验证授权、首帧和停止等行为，记录设备与产物 |
| Android 控制端 | `AN-01`～`AN-07` | 按 007 用固定 Gradle Wrapper 跑 `testDebugUnitTest` 和 `connectedDebugAndroidTest`，用 Debug CTest 验证共用 C++ |
| M1 首发组合 | `ANH-01`～`ANH-03`、`M1H-01`～`M1H-06` | Android 10+ ARM64 真机与 Windows 电脑局域网直连。保存设备、构建标识、链路与原始证据到 `test-results/m1/` |

[004 Android 被控端验收](../increments/004-android-screen-capture/tasks.md) · [007 Android 控制端验收](../increments/007-android-controller/tasks.md) · [001 M1 真机验收](../increments/001-android-controls-windows-over-lan/spec.md#42-真机验收)

```bash
# 查看可运行的用例名
ctest --preset debug -N
ctest --preset release -N

# 按改动选跑目标测试，例如帧移交
ctest --preset debug -R '^capture\.frame_handoff\.' --output-on-failure

# 全量 Debug 验证
cmake --preset debug
cmake --build --preset debug -j
ctest --preset debug --output-on-failure

# 涉及 NDEBUG 分支时加跑 Release
cmake --preset release
cmake --build --preset release -j
ctest --preset release --output-on-failure
```

### 帧移交现有用例

下表中的 CTest 名称统一带 `capture.frame_handoff.` 前缀。表内记录已接线的断言范围。 [帧移交规格](../increments/002-screen-frame-handoff/spec.md) · [测试源码](../../tests/unit/capture/frame_handoff_test.cpp)

| 规格编号 | CTest 名称后缀或构建检查 | 已接线的断言 |
| --- | --- | --- |
| `FH-01` | `FrameSlotTest.EmptySlotReturnsNullAndKeepsCounts` | 空槽返回与池计数 |
| `FH-02` | `FrameSlotTest.PublishedFrameKeepsDescAndPixelSize` | 同一帧、描述符与像素大小 |
| `FH-06` | `FrameSlotTest.PublishNullIsNoOp` | 空发布保留槽状态与池计数 |
| `FH-07` | `FramePoolTest.ExhaustedPoolReturnsNull` | 池耗尽时的空返回与计数。采集端跳过、分配和时延仍需证据 |
| `FH-08` | `FramePoolTest.ReleasingAllRestoresCapacity` | 释放后恢复池容量 |
| `FH-19` | `frame_handoff.h` 中的 `static_assert` | 构建目标上的原子类型无锁约束。以构建结果为证据 |
| `FH-23` | `FrameWriteViewTest.WritableBeforePublish`，以及 Debug 的 `FrameWriteViewTest.ClosedAfterPublishAbortsInDebug`、Release 的 `FrameWriteViewTest.ClosedAfterPublishInRelease` | 发布前视图可用，发布后 Debug 的描述符访问触发断言，Release 的描述符与像素视图返回空值。其余规格断言仍需证据 |

## 属性测试与复现

先从已批准的规格确定要检查的不变量。以 `FH-09` 为例，生成合法的帧发布、取得和释放序列，按规格在每步结束的快照检查池容量守恒，并在清理后检查容量恢复。保存失败输入、种子、复现命令和被测版本。能缩减输入时保留最小反例，并把有效反例加入固定回归用例。

## 记录实际验收

每次验证记录被测 Git SHA、相关未提交改动范围、平台和构建配置。按验收编号或 CTest 名称记录运行命令、`通过`、`失败` 或 `未运行`、实际观察和日志路径。新增行为同时记录红灯的失败原因和绿灯的结果。候选 APK 另记版本、产物标识和真机型号，首帧和回调耗时按增量规格记录。仅执行了部分断言时，列出尚无证据的验收条件。
