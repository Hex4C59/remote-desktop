# 任务07／08：用户授权的视觉复核（2026-10-13）

用户要求“你帮我做了啊,我授权你完成”，将剩余帧判读、复读和负载核对交由Agent完成。本轮按此授权采用AI视觉判读，取代本轮结项所需的人工判读步骤。原采样协议的 `ai_review_acceptance=false` 与此前“人工复核0”的历史记录保留；本轮人工复核仍为0，不能宣称原人工专属条件已经满足。两类物理显示测量继续延期、未验收。

复核者和复读者均为 `Codex-visual-2026-10-13`，是同一AI的两遍核对，没有独立复核者。首遍按时间顺序查看解码图像与候选前后帧，终端按回调时间轴检查完整输入、编译输出、首条运行输出和提示符；次遍反向排列操作，重新读取40对边界。另看五轮运行首帧的完整终端画面，以及全部中断样本采样结束的画面，核对目录、源码revision、编译结果、运行结果和提示符稳定返回。OCR与变化候选只作导航：旧候选曾选到反馈早已出现的后续帧，未直接用于有效统计。未逐一复读全部8,052张图像，复读范围是全部40个正式反馈边界及上述负载证据。

原始图像保存在忽略目录；公开复核记录绑定实验、会话、操作、索引及两帧原始文件SHA-256。发送与回调入口时间均为控制端 `elapsedRealtimeNanos`，先以整数纳秒相减，再转换为毫秒。区间为 `[max(0,最后无完整反馈入口−发送),最早完整反馈入口−发送]`。连续指相邻已保存观察；若其间有采样缺口则不完整，不输出有效耗时。较长的相邻回调间隔而没有保存缺口时保留较宽区间，不插值，也不据此声称已知反馈出现的精确时刻。

任务07共20次有效尝试，四类各5次；另外3次方法验证在原始日志中仍是formal，4次预热仍是warmup，全部留在分析文件中，正式统计范围用显式 `formal_scope` 固定为预先选定的20次，没有改写原始phase。任务08共20次已判读并复读，18有效、2不完整；两次缺口均为text_submit，保留失败分母。双方均没有发送失败、超时、不可判读、会话结束、未执行或人工排除的正式尝试。

原600秒统计窗口、3,392帧有效重导包与采集版本没有变化。基线仍使用SHA-256 `32002be1f354282cf1664fa2348a9c93f48b7708900871ddbc52f2eb9d30ed94` 的有效重导包；首份CRC失败副本及后续差异副本保留。导出错误根因仍未定位，见[完整性续查](task07-export-integrity.md)。此次复核没有新增设备运行或更新平台构建、输入回归证据。

## 逐项边界与结果

表中上界是所选完整反馈帧的观察耗时。缺口样本仅展示诊断区间，不计入中位数。每行均已由同一AI复读。

| 任务 | 操作 | 类型 | 最后无完整反馈→最早完整反馈帧 | 相邻帧区间 ms | 结果 |
| --- | --- | --- | --- | --- | --- |
| 07 | 0005 | pointer_feedback | 1330→1331 | [53.036459, 88.884375] | valid |
| 07 | 0006 | pointer_feedback | 1592→1593 | [56.997395, 97.140625] | valid |
| 07 | 0007 | pointer_feedback | 1863→1864 | [54.280208, 92.469271] | valid |
| 07 | 0008 | pointer_feedback | 2124→2125 | [46.602604, 84.415625] | valid |
| 07 | 0009 | pointer_feedback | 2384→2385 | [41.476042, 78.807292] | valid |
| 07 | 0011 | window_text | 2901→2902 | [45.539584, 91.478646] | valid |
| 07 | 0012 | window_text | 3170→3171 | [75.113021, 120.061458] | valid |
| 07 | 0013 | window_text | 3428→3429 | [81.448959, 106.740625] | valid |
| 07 | 0014 | window_text | 3696→3697 | [334.118750, 363.907813] | valid |
| 07 | 0015 | window_text | 3947→3948 | [106.477604, 136.396875] | valid |
| 07 | 0017 | window_enter | 4467→4468 | [42.570312, 95.210937] | valid |
| 07 | 0018 | window_enter | 4728→4729 | [57.044271, 93.785416] | valid |
| 07 | 0019 | window_enter | 4994→4995 | [76.801562, 123.864583] | valid |
| 07 | 0020 | window_enter | 5255→5256 | [41.579167, 79.236979] | valid |
| 07 | 0021 | window_enter | 5516→5517 | [61.808333, 98.143750] | valid |
| 07 | 0023 | interrupt_return | 6021→6022 | [90.310938, 143.182813] | valid |
| 07 | 0024 | interrupt_return | 6281→6282 | [135.251041, 171.778646] | valid |
| 07 | 0025 | interrupt_return | 6540→6541 | [149.794271, 188.383854] | valid |
| 07 | 0026 | interrupt_return | 6796→6797 | [132.483333, 169.391146] | valid |
| 07 | 0027 | interrupt_return | 7066→7067 | [128.187499, 502.701041] | valid |
| 08 | 0001 | text_submit | 184→186 | [22.926042, 87.734375] | incomplete |
| 08 | 0002 | compile_start | 444→445 | [184.352604, 206.438542] | valid |
| 08 | 0003 | program_start | 713→714 | [497.144791, 551.302083] | valid |
| 08 | 0004 | interrupt_return | 1004→1005 | [165.044791, 203.164062] | valid |
| 08 | 0005 | text_submit | 1330→1332 | [43.115625, 110.788021] | incomplete |
| 08 | 0006 | compile_start | 1589→1590 | [113.648958, 181.427083] | valid |
| 08 | 0007 | program_start | 1824→1825 | [738.240625, 1032.365625] | valid |
| 08 | 0008 | interrupt_return | 2007→2008 | [199.434895, 237.741145] | valid |
| 08 | 0009 | text_submit | 2337→2338 | [99.197395, 151.561979] | valid |
| 08 | 0010 | compile_start | 2597→2598 | [122.689063, 157.112500] | valid |
| 08 | 0011 | program_start | 2864→2865 | [1000.851563, 1267.444271] | valid |
| 08 | 0012 | interrupt_return | 3033→3034 | [193.484375, 230.859896] | valid |
| 08 | 0013 | text_submit | 3363→3364 | [83.265625, 121.811459] | valid |
| 08 | 0014 | compile_start | 3623→3624 | [121.231250, 161.554687] | valid |
| 08 | 0015 | program_start | 3893→3894 | [508.432292, 543.502083] | valid |
| 08 | 0016 | interrupt_return | 4171→4172 | [140.093750, 176.719792] | valid |
| 08 | 0017 | text_submit | 4497→4498 | [89.294271, 120.611979] | valid |
| 08 | 0018 | compile_start | 4756→4757 | [123.640625, 152.760938] | valid |
| 08 | 0019 | program_start | 5025→5026 | [486.700521, 547.736458] | valid |
| 08 | 0020 | interrupt_return | 5312→5313 | [134.595833, 172.228125] | valid |

任务08缺口：0001的frame185、0005的frame1331，原因均为queue_overflow。任务07的0027为[128.187499,502.701041] ms，其间没有保存缺口记录；区间宽度374.513542 ms应与中位数一同阅读。基线program_start的0007／0011反馈分别在1,032.365625／1,267.444271 ms，图像暂时变差且回调稀疏，完整revision与tick仍可辨认；这些慢样本保留在范围和中位数中。

## 五轮负载与复算

31条独立审计记录依次为prepared及五轮browsed、edited、compile_started、compile_finished、run_started、run_returned，五次编译退出均为0。实际视频完整帧显示revision=1到5的源码与对应运行tick=0；中断后提示符稳定到采样结束，最后tick分别为42。审计的UTC仅用于顺序阅读，耗时不与它相减。审计SHA-256为 `1cca698cca9650fde441bc6172b4c04d3a05fbd6d33a530c6e15066e147bbb0e`。Ctrl+C审计返回码保留为-1073741510，未改写为正常退出0。控制端同机操作起点证实每轮各四类尝试，采样窗口互不重叠。

使用[任务07复核记录](evidence/task07-authorized-review.json)、[任务08复核记录](evidence/task08-authorized-review.json)及[负载上下文](evidence/task08-authorized-context.json)复算；原实验目录从已校验ZIP恢复到忽略目录。以下命令的原始路径均是占位位置，替换为本地实际回收位置。原始分析与索引时间戳不修改。

```sh
python3 scripts/latency/software.py analyze .local/run/task07-experiment docs/validation/evidence/task07-authorized-review.json .local/run/task07-feedback.json
python3 scripts/latency/software.py analyze .local/run/task08-experiment docs/validation/evidence/task08-authorized-review.json .local/run/task08-feedback.json
python3 scripts/latency/baseline.py baseline .local/run/receiver-statistics.jsonl .local/run/stages.jsonl .local/run/task08-feedback.json .local/run/task08-experiment/baseline.json .local/run/workload.jsonl docs/validation/evidence/task08-authorized-context.json .local/run/baseline-report.json
```

公开[任务07计算结果](evidence/task07-authorized-analysis.json)保留27个采集记录与20次正式统计，[任务08反馈计算结果](evidence/task08-authorized-feedback.json)保留20次尝试，包括两次不完整边界。原始证据缺失时，公开摘要可核对计算但不能独立重做图像判读。authorization是用户委托的审计记录，不是密码学签名。软件观察耗时来自开启测量的运行，包含发送之后的实际桌面执行与反馈视频处理，不代表物理屏幕呈现，也不能仅凭本地阶段中位数推断全部端到端瓶颈。
