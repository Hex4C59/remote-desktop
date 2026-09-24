# 字符与终端按键（任务04）

正常配对连接后，先触摸视频中的 Windows 终端取得焦点。在手机的文本框编辑英文、数字和符号，点击“发送文本”送入远端；再点击 Enter 执行。工具栏还提供 Tab、四个方向键、Backspace 和 Ctrl+C。手机文本框中的编辑只改变本地草稿，远端编辑使用工具栏按键；中文输入法和剪贴板同步不在本版范围内。

界面避让系统栏、导航手势区和软键盘。手机键盘打开时，收起状态和远端按键行，保留文本框、发送按钮及缩小后的桌面；发送文本会关闭手机键盘并恢复桌面和按键行。

## 消息语义

输入复用已授权 PeerConnection 的可靠、有序 DataChannel，与[指针点击](pointer-input.md)按接收顺序处理。所有消息都是 UTF-8 文本，不接受二进制输入。

| 消息 | 语义 |
| --- | --- |
| `text:<内容>` | 1–256 个可打印 ASCII 字符（0x20–0x7e），冒号后的整个后缀为原文，保留空格、冒号和符号；禁止换行、控制字符和非 ASCII 字符 |
| `key:enter`、`key:tab` | 一次 Enter 或 Tab 按下及释放 |
| `key:left`、`key:right`、`key:up`、`key:down` | 一次方向键按下及释放 |
| `key:backspace` | 一次退格按下及释放 |
| `key:ctrl+c` | Ctrl 按下、C 按下、C 释放、Ctrl 释放 |

文本通过 Windows `KEYEVENTF_UNICODE` 成对注入，不把符号转换为依赖键盘布局的物理快捷键，也不使用剪贴板。功能键使用 Windows 虚拟键码，方向键带扩展键标志。每条消息完整校验后，使用一次 `SendInput` 批量提交；文本消息不会隐含 Enter。

协议没有单独的 down/up 消息，也不允许跨网络保持 Ctrl。完整批次已经包含释放；部分注入失败时只补发该批次尚未配对的释放，若仍失败则在输入对象销毁时重试。注入失败结束会话，避免接着执行残缺的命令。普通交互桌面和 Windows UIPI 限制沿用任务03，安全桌面和提权窗口不在运行范围内。

## 授权与结束

键盘和鼠标共用一个最多32条的 Windows 待执行队列，仅在正常配对的桌面会话中启用。每次执行前重新检查授权、TLS 连接及媒体会话状态。等待超过500毫秒的键盘输入会结束会话，避免丢掉字符后仍执行后续 Enter；过期指针点击沿用任务03的丢弃策略。

文件信令探针不开放键盘权限。断开或切后台后，控制端停用输入，Windows 丢弃剩余待执行消息并销毁输入对象。消息归属于创建它的授权媒体会话，没有可在新会话中复用的全局输入入口。任务05继续补齐完整断网判定与手动重连。

手机只有在授权、首帧和 DataChannel 打开后才启用终端控件，停止会话时立即停用。文本发送失败保留草稿并提示；提交到 DataChannel 成功只表示已交给传输层，最终结果仍以视频中的 Windows 终端为准。应用日志不记录输入的文本内容。

## 复现

按[两端构建说明](../guides/webrtc-probes.md)构建并安装后，在 Windows 已登录且未锁定的交互桌面执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\test-terminal-input.ps1 -Address <电脑IPv4>:18443 -Sender D:\tools\remote-desktop\webrtc-windows\src\out\remote-desktop-win\sender.exe
```

脚本通过应用正常地址和口令入口连接，手机触摸取得真实 PowerShell 终端焦点，再使用文本框和工具栏操作。运行期间留出 Windows 本地键鼠；每次发送前检查终端仍为前台窗口，失焦立即停止。终端使用独立临时工作目录，结果文件和手机截图用于判断字符、执行、补全、编辑、历史和中断行为；DataChannel 回显只承担连通性检查。原始终端、桌面截图和日志保留在忽略的运行目录，公开证据不包含配对口令或 SDP。

同时连接多台 USB 设备时，增加 `-DeviceSerial <原验收手机的ADB序列号>` 固定测试对象；触屏、配对和文件模式回归脚本也支持此参数。省略时继续要求只有一台 USB Android 设备。

接口依据：[Microsoft SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)、[Android 系统栏与 IME 边距](https://developer.android.com/develop/ui/views/layout/edge-to-edge)。
