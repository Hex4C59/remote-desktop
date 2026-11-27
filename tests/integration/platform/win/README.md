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
| PWH-01、PWH-06 | `ctest --preset windows-desktop -R Pwh01And06 -V` | 保持桌面解锁 60 秒。程序让测试窗口持续变色，记录进程私有内存、实际交付帧率与帧龄，以及每次零等待调用的耗时。 |
| PWH-02 | `ctest --preset windows-desktop -R Pwh02 -V` | 保持桌面解锁。程序临时切换主显示器分辨率，并核对原分辨率和刷新率已恢复。 |
| PWH-03 | `ctest --preset windows-desktop -R Pwh03 -V` | 看到窗口和 `PWH-03 READY` 后，按 `Win+L`，等待约两秒，再正常解锁。程序等待锁屏通知最长 150 秒，之后等待解锁通知最长 60 秒。 |
| PWH-04、PWH-05 | `ctest --preset windows-desktop -R 'Pwh04|Pwh05' -V` | 测试提示需要焦点时，单击测试窗口标题栏。光标会移到窗口内。程序核对点击、文本、关闭窗口后释放 F8 和左键，以及新代次可继续注入。 |

PWH-06 以 `timeout=0ms` 轮询。提交、未就绪、超时和成功返回均计入调用耗时，比较最大值和 6 ms 上限。交付帧龄使用采集时的单调时间戳，结合读回就绪和丢弃计数核对 33 ms 采集周期。PWH-01 从预热后开始读取 Windows 进程私有内存，末次采样必须不高于初次。

## 对照私有内存

启动独立进程运行各项对照。程序沿用 60 秒窗口负载，在初始化前、预热后、测试期间及释放后采样。采集窗口以禁止激活的方式变色，键鼠验收使用能获得焦点的窗口。对照依次增加显示查询、采集器初始化、无像素探测和完整像素读回。输出包含进程私有提交、每个可读取的堆和窗口资源计数。分别在释放采集器、帧池和测试窗口后采样。目标进程 PID 可用于关联本机追踪，需要具备 Windows Performance Toolkit 所需权限。

```bash
exe=build/windows-desktop/tests/integration/platform/win/platform_win_desktop_acceptance.exe
"$exe" --gtest_filter=MemoryDiagnostics.ReportsProcessHeapAndConsistentTotals
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlPaint
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlDisplayQueries
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlInitialized
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlProbe
"$exe" --gtest_filter=DesktopAcceptance.MemoryControlPixels
```

## 保存验收证据

把 `-V` 输出保存到 `test-results/platform-win/`，附上 Git SHA、工作区改动、显示模式、驱动版本和构建配置。按 [实际验收记录约定](../../../../docs/verification/README.md#记录实际验收) 保存每项通过或失败的观测结果。日常全量回归用 `ctest --preset debug --output-on-failure`。
