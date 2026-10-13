# 十分钟固定 C++ 局域网基线

先完成[软件测量方法验证与正式采样](software-measurement.md)，再运行本基线。两端软件测量开启，正常配对后预热至少30秒，在同一授权会话运行600秒；中途断线保留中断记录，重新连接后换实验编号。

## 固定负载

在 Windows 已登录、未锁定桌面打开新的经典 PowerShell 控制台，dot-source `scripts/windows/show-cpp-baseline.ps1 -OutputDirectory <新的专用忽略目录>`。脚本仅在此进程初始化 MSVC 环境，建立小型 `sample.cpp`，记录操作审计；每个命令执行前检查该控制台仍在前台。保持窗口、字体、显示缩放、编码配置和网络条件固定。

Android 测量对话框点击“开始十分钟基线”。窗口自动记录控制端单调时钟起终点，结束后生成 `baseline.json`；会话提前结束记录 `interrupted`。它记录发送分类数量，实际工作负载还必须用 `workload.jsonl` 和视觉证据复核，不凭分类计数验收。

每轮120秒，共五轮。第N轮以基线起点后 `(N−1)×120` 秒为起点，提前安排未采样的输入，四个采样窗口互不重叠。推荐按下表的相对时刻操作；实际起点以日志为准，每轮必须包含各类别一次正式尝试。

| 轮内时刻 | 桌面操作 | 分类与完整反馈判据 |
| --- | --- | --- |
| 0秒 | 提交并执行 `browse_demo`，浏览专用目录 | 非正式采样；审计记录本轮目录浏览 |
| 10秒 | 在终端普通输入位置提交文本 `edit_demo N`（暂不Enter） | `text_submit`：整条命令文字出现在输入行 |
| 20秒 | 非采样 Enter 执行修改，检查输出源码 | `revision = N` 已更新 |
| 40秒 | 先非采样输入 `compile_demo`，准备采样后Enter | `compile_start`：出现本轮 MSVC 编译输出；前轮输出不算 |
| 60秒 | 编译成功后，先非采样输入 `run_demo`，准备采样后Enter | `program_start`：本轮 `revision=N` 的首条运行输出完整出现 |
| 80秒 | 准备采样后Ctrl+C | `interrupt_return`：程序停止且终端提示符完整返回 |
| 90—120秒 | 检查结果及审计、等待下一轮 | 避免新操作干扰五秒采样窗口 |

准备操作时明确预期反馈；每次等1秒前序画面，再执行输入，之后等5秒。计时不依赖 Windows 与控制端墙钟相减。脚本中的 UTC 只用于审计阅读；五轮分布由同机输入时间判定。审计须包含五轮 `browsed → edited → compile_started → compile_finished → run_started → run_returned`，编译退出码为0；复核者还应确认每轮 Ctrl+C 和结果检查。

## 回收与可复算报告

会话结束后回收 Android 实验目录、Windows 阶段日志、对应任务06统计及 `workload.jsonl`。按软件测量指南逐帧复核全部正式边界，再生成 `feedback.json`。公开证据只保留方法、结果、版本、哈希和限制；原始桌面图像、机器地址与路径留在忽略目录。

保存用户本地 `context.json`，schema 为 `lan-run-context-v1`，填写实验和会话、两端设备/系统、网络、源码与依赖版本、产物 SHA256、工作负载复核者及 `workload_reviewed`。字段如下；示例是填写模板，不是实测证据。

```json
{
  "schema": "lan-run-context-v1",
  "experiment": "从baseline.json复制",
  "session": "从baseline.json复制",
  "controller": "已重新核对的型号、系统与设备标识",
  "controlled_host": "已重新核对的系统、显示器、缩放与桌面会话",
  "network": "实际LAN条件（原始地址保存在本地）",
  "versions": {"source": "提交哈希及源码差异", "webrtc": "清单中的实际revision"},
  "artifact_sha256": {"sender": "实际SHA256", "apk": "实际SHA256"},
  "workload_reviewer": "复核者",
  "workload_reviewed": false
}
```

```sh
python3 scripts/latency/baseline.py baseline .local/run/statistics.jsonl .local/run/stages.jsonl .local/run/feedback.json .local/run/experiment/baseline.json .local/run/workload.jsonl .local/run/context.json .local/run/baseline-report.json
```

报告分别给出 `collection_completed` 和 `target_720p30_reached`。采集完成要求同会话600秒、经复核确认的完整五轮工作负载、每轮四类尝试、全部尝试已复核、统计和阶段数据可用。失败尝试保留，不要求全部反馈有效才能报告基线；有效数量为0的类别没有软件耗时参考值。

720p30判定使用实际提交/解码1280×720、按实际窗口加权平均至少30 FPS、统计覆盖率至少99%、窗口内无已报告冻结且无统计序号缺失。99%是本报告的数据覆盖判据，帧率没有容差；未达到时逐项记录偏差。源尺寸另报，不将源分辨率当作解码分辨率。库冻结累计值仅以窗口内两个端点相减，边缘可能少计；阶段统计按最近送达的任务06序号近似对应窗口。

报告按本地独立阶段中位数排序瓶颈，`capture_ns` 和 `total_ns` 作为整体指标另列，避免与子阶段重复排名。按类别的有效反馈中位数作为下一阶段软件参考上限；弱网候选为接收负载平均码率75%、额外单向延迟50ms、随机丢包1%。它们是任务09输入，限制实际作用路径仍由任务09验证。

结束与手动重连回归放在长测之外，另存记录。测量开销两分钟对照也独立运行。缺少实机运行、复核或统计时保留未验收，不能用合成测试报告填入正式结果。


用户委托Agent复核时，使用软件测量指南的v2记录，`context.json`另填 `workload_reviewer_kind=ai` 和同一 `review_authorization`；必须与反馈分析中的用户委托一致。负载复核须实际查看五轮目录、源码修改、编译／运行输出与中断返回的图像，并核对独立审计，不能只凭600秒计时器或分类数量。报告分别保留人工／AI判读、复读数量及同一AI的限制，结项口径改变在任务记录说明；原人工专属条件不能宣称满足。
