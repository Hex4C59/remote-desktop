# 触屏定位与点击（任务03）

通过地址和临时配对口令连接后，在手机显示的桌面画面内轻触并松手，Windows 指针移动到对应位置并执行一次左键点击。可用于选择终端窗口和改变焦点；任务04提供[字符与终端按键](terminal-input.md)。

## 坐标与手势

Android 将 `SurfaceViewRenderer` 居中放入可用区域，允许渲染器按视频比例测量宽高，使用 `SCALE_ASPECT_FIT` 完整显示画面。触摸只在实际视频区域生效，四周留边不产生点击。单指按下和松手都须处于画面内，移动超过系统 touch slop、跨出画面、多指、取消和布局变化会取消本次点击。

控制端把视频区域坐标归一化为两个 0–65535 整数，通过已配对 PeerConnection 的可靠、有序 DataChannel 发送 UTF-8 文本：`pointer:click:<x>:<y>`。左上角对应 0,0，右下角对应 65535,65535。桌面源已经完成旋转，发送视频的 rotation 为0。协议不接受单独的按下消息，没有跨网络保持鼠标按住的状态。

被控端使用 Desktop Duplication 实际选择的输出矩形，映射到物理桌面像素，再转换到 Windows 虚拟桌面的绝对输入坐标。这包含显示器原点偏移和 Windows DPI 缩放；不把所有点击直接映射到主显示器。注入前检查该显示器矩形仍然存在；显示模式变更导致采集失败时结束会话，重新启动后再连接。

## 授权、线程与结束

只有 `--serve` 模式经过 TLS 配对授权后才创建输入对象；文件信令探针始终没有桌面输入权限。输入随当前 PeerConnection 的 DataChannel 到达，不接受第二个控制端的输入连接。认证及媒体身份绑定沿用[配对协议](pairing-protocol.md)。

Android 在收到首帧、DataChannel 打开后才允许触摸发送。发送工作在 RTC 工作线程执行，发送前再次检查授权、会话结束状态和布局版本。应用最多排队8条输入（任务04起与键盘共用），DataChannel 已有待发送数据时拒绝新点击。

Windows 回调只接收并排队；鼠标注入在采集主线程执行，队列最多32条，溢出结束会话，等待超过500毫秒的点击丢弃。每次执行前重新检查配对连接和媒体会话是否仍有效。媒体断开或 DataChannel 关闭后停止接收输入；TLS 结束后主循环退出。应用切后台关闭配对与媒体连接，已结束会话的排队点击不能继续注入。

一次 `SendInput` 批量提交移动、左键按下和左键释放，避免松手依赖下一条网络消息。发生部分写入时立即尝试补发释放；若仍失败，输入对象在所有正常退出和错误返回路径销毁时再尝试释放，并记录失败。Windows 安全桌面或系统拒绝注入时无法保证补发成功；本项目的运行前提仍是已登录、未锁定的普通交互桌面。管理员权限窗口受 Windows UIPI 限制，不属于本次控制范围。

DXGI 独立鼠标指针尚未叠加到视频中。任务03的可见反馈是目标终端的焦点和内容变化；原生鼠标光标不保证出现在手机画面上。

## 复现

按[两端构建说明](webrtc-probes.md)构建并部署 APK，在 Windows 交互桌面执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\test-touch-pointer.ps1 -Address <电脑IPv4>:18443 -Sender D:\tools\remote-desktop\webrtc-windows\src\out\remote-desktop-win\sender.exe
```

脚本创建专用终端和本次被控端进程，通过 ADB 操作应用正常配对界面及触摸界面。终端使用 Windows 控制台输入事件独立观测真实按下和释放，记录焦点、指针位置、按钮状态，并保存手机截图；不把被控端自报成功或 DataChannel 回显当成点击验收。日志和截图保存在忽略的 `build/touch-tests/<run-id>`；凭据不写入公开记录。

接口依据：[Microsoft SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[MOUSEINPUT 绝对坐标](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)。Android 测量行为核对固定 WebRTC checkout 的 `SurfaceViewRenderer.java` 和 `RendererCommon.java`。
