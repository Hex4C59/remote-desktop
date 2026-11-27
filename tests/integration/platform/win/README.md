# 003 Windows 交互桌面验收

在被控端电脑的 Windows 控制台登录并解锁，使用单显示器 SDR。验收程序会显示一个测试窗口，采样窗口颜色并核对键鼠和 ASCII 文本事件。测试日志记录测量数据和断言结果。

## 构建并选择验收用例

```bash
cmake --preset windows-desktop
cmake --build --preset windows-desktop -j
ctest --preset windows-desktop -N
```

| 验收编号 | 运行命令 | 需要的本机操作 |
| --- | --- | --- |
| PWH-01、PWH-06 | `ctest --preset windows-desktop -R Pwh01And06 -V`，固定三个独立进程 | 每个进程保持桌面解锁及窗口可见 60 秒。原 40 帧预热后每秒记录实际时间和私有内存，并核对像素、帧率、帧龄及全部零等待调用。 |
| PWH-02 | `ctest --preset windows-desktop -R Pwh02 -V` | 保持桌面解锁。程序临时切换主显示器分辨率，并核对原分辨率和刷新率已恢复。 |
| PWH-03 | `ctest --preset windows-desktop -R Pwh03 -V` | 看到窗口和 `PWH-03 READY` 后，按 `Win+L`，等待约两秒，再正常解锁。程序等待锁屏通知最长 150 秒，之后等待解锁通知最长 60 秒。 |
| PWH-04、PWH-05 | `ctest --preset windows-desktop -R 'Pwh04|Pwh05' -V` | 测试提示需要焦点时，单击测试窗口标题栏。光标会移到窗口内。程序核对点击、文本、关闭窗口后释放 F8 和左键，以及新代次可继续注入。 |
| PWH-07 | `ctest --preset windows-desktop -R Pwh07 -V` | 保持窗口可见并连续采集 600 秒，只做一次 40 帧预热，不重建、不重置基线。 |
| PWH-08 | `ctest --preset windows-desktop-diagnostics -R Pwh08 -V` | 独立诊断构建通过 CDB 收集 SDK 报告。十轮交替覆盖正常和读回在途时销毁，逐轮检查帧池与命名资源释放。 |

PWH-06 以 `timeout=0ms` 轮询。提交、未就绪、超时和成功返回均计入调用耗时，比较最大值和 6 ms 上限。交付帧龄使用采集时的单调时间戳，结合读回就绪和丢弃计数核对 33 ms 采集周期。

2026-11-27 批准的 PWH-01、PWH-07 内存预算为：末次相对首样净增最多 65,536 字节，任何实际采样相对首样最多增加 262,144 字节。首样在原 40 帧预热后读取，末样在完整测量期结束后、排序、输出及销毁前读取。存储在测量前分配，每秒保存实际单调时间和完整进程的 `PrivateUsage`，不扣估计开销。64 KiB 是工程预算，不是系统噪声上界；项目泄漏须修复。固定三个 PWH-01/06 独立进程须全部通过，随后还需 PWH-07、PWH-08；失败、遮挡和前提不满足的运行完整保留，不挑选某次通过。PWH-07 记录全部调用，但不把 6 ms 判定窗口延长到十分钟。

```bash
cmake --preset windows-desktop-diagnostics
cmake --build --preset windows-desktop-diagnostics -j
ctest --preset windows-desktop-diagnostics -R Pwh08 -V
```

诊断配置单独存放于 `build/windows-desktop-diagnostics`。D3D11 调试层和 `rd.capture.*` 名称只在诊断构建初始化时启用。SDK 报告分别检查基线、在用及销毁作用域后最多两秒的对象，缺少在用名称、诊断能力或销毁后仍残留均不能通过。生产析构不增加等待。

## 对照私有内存

启动独立进程运行各项对照。程序沿用 60 秒窗口负载，在初始化前、预热后、测试期间及释放后采样。采集窗口以禁止激活的方式变色，键鼠验收使用能获得焦点的窗口。对照依次运行仅观察桌面状态、绘制窗口、显示查询、采集器初始化、无像素探测和完整像素读回。`MemoryControlObserver` 不创建测试窗口或 D3D11 设备，仅推进原生桌面事件源；它使用两秒准备时间并记录随后 60 秒的私有内存。该诊断与 PWH-01 的 40 帧预热分别记录。其余对照输出包含进程私有提交、每个可读取的堆和窗口资源计数。分别在释放采集器、帧池和测试窗口后采样。目标进程 PID 可用于关联本机追踪，需要具备 Windows Performance Toolkit 所需权限。

```bash
exe=build/windows-desktop/tests/integration/platform/win/platform_win_desktop_acceptance.exe
"$exe" --gtest_filter=MemoryDiagnostics.ReportsProcessHeapAndConsistentTotals
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlObserver
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlPaint
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlDisplayQueries
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlInitialized
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlProbe
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlPixels
```

## 保存验收证据

把 `-V` 输出保存到 `test-results/platform-win/`，附上 Git SHA、工作区补丁、二进制 SHA、窗口位置与遮挡、显示模式、驱动版本和构建配置。保存全部成功、失败、逐秒时间序列、每分钟变化及逐轮对象报告。原零增长条款的历史记录保持原结论。按 [实际验收记录约定](../../../../docs/verification/README.md#记录实际验收) 逐项核对，全部门槛达标前保持 T006 开放。

可用测试启动器预先登记三个进程的次序及二进制 SHA，再串行调用上述 CTest 命令。每轮结果写入独立时间目录；其中一次失败就使整个批次失败，后续结果不会覆盖它。窗口由测试程序在预热前自行定位，启动器不操作窗口句柄。测试程序在运行前以会话内命名互斥量拒绝并发桌面验收。

```bash
python tests/integration/platform/win/run_capture_acceptance.py --output-dir test-results/platform-win/pwh01-batches
python tests/integration/platform/win/run_capture_acceptance.py --test Pwh07 --runs 1 --timeout 680 --output-dir test-results/platform-win/pwh07-runs
```

资源报告解析的自动用例包含从真实报告派生的记录，以及明确标注的合成 duplication 行。合成行只验证解析规则，不能作为 SDK 已报告该对象的证据；真实报告缺少任一项目名称仍必须失败。诊断在资源创建前启用线程追踪，SDK 报告包含内部引用，避免把外部引用释放误当成 GPU 资源已释放。

2026-11-27 按本轮规则执行的全部结果见本地 `test-results/platform-win/t006-budget-revision.md`。内存预算达标并未消除像素、光标位置和 duplication 报告的失败；任务继续开放。日常全量回归用 `ctest --preset debug --output-on-failure`。
