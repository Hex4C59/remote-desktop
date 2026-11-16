# Linux 被控端

新增 Linux x64/Xorg 被控端，兼容现有 Android 应用的局域网 TLS 配对、WebRTC 视频、触屏点击、ASCII 终端输入和视频统计回执。

## 构建

在 Linux x64 的项目目录执行，参数为项目固定版本的外部 libwebrtc 源码目录：

```sh
bash scripts/linux/build-linux-sender.sh "$WEBRTC_SRC" 4
```

脚本校验 `scripts/webrtc/webrtc-build-candidate.json` 中的 WebRTC commit。使用树内 Clang/LLD、Bullseye amd64 sysroot 和 Ninja；X11、XTest、XRandR、GTK3 开发依赖应存在于 sysroot。目标机器是 Ubuntu 24.04.5 x64。

独立生成 `remote_desktop_linux/` overlay 和 `out/remote-desktop-linux/`，产品为 `linux_sender`。测试目标是四个 `linux_*_fixture`；现有 `remote_desktop_probe/`、Android输出和Windows构建入口不受影响。overlay 将 Linux 源码与 Windows 目录中现有的可移植 FrameSource 接口、统计实现组装到独立 include 根目录，保留 include 名称，不修改原源码。

## 运行

在机器上登录并选择 **Ubuntu on Xorg**，保持桌面未锁定。从该用户图形桌面的终端运行：

```sh
"$WEBRTC_SRC/out/remote-desktop-linux/linux_sender" --check-environment
"$WEBRTC_SRC/out/remote-desktop-linux/linux_sender" --serve
```

Android 输入此电脑可达的局域网 IPv4 地址（默认 TCP 18443）与 GTK 窗口中的64位配对口令。证书指纹和随机凭据绑定当次会话；五分钟过期、最多十次失败、成功后仅一个控制端。口令不会写入日志，授权后窗口同步隐藏，再启动采集与媒体。网络须允许两端直连TCP18443与WebRTC协商的UDP端口；普通使用不需要USB或SDP文件。

登录环境使用 `XDG_SESSION_ID` 定位 logind 会话；变量缺失时按当前进程查找。只允许当前普通用户、active、未锁定的 x11 user 会话，并要求可访问的显示连接。SSH/TTY、GDM、其他用户、Wayland和锁定会话均拒绝。SSH启动时必须显式提供已经确认的用户图形会话ID及该会话的DISPLAY/XAUTHORITY，不能把SSH会话本身当作图形桌面；不自动扫描或附着其他会话。机器信息仅放本地配置。

默认采集主显示器，保持比例缩小至最大1280×720。30FPS和4Mbps是配置上限，不是实测保证。显示器矩形变化、采集失败、logind会话失活/锁定、TLS/媒体/输入通道关闭都会结束会话。桌面状态每秒检查，执行每条输入前另行检查会话；GTK在主线程，采集/输入与网络/信令分线程。

点击、文本与按键采用现有协议。输入队列最多32条，500毫秒过期点击丢弃，过期键盘输入结束会话。文本为1–256个可打印ASCII，按当前XKB布局完整预检后注入，不修改布局；Caps/Num锁定状态参与映射，并支持AltGr（ISO_Level3_Shift）和Shift+AltGr。字符不可直接映射或本机有按键、鼠标按钮按住时结束会话，避免静默输入错误。所有按下/释放成对；本程序只释放自己持有的输入。

应用结束、切后台或断网后需要手动重连：重新启动Linux被控端取得新口令，并使用Android的重新连接入口。接收统计保存格式和`stats-saved`回执与Windows一致；回执表示刷新了本地日志，不等同持久介质落盘或画面已显示。

## 隔离测试

```sh
python3 scripts/linux/test-linux-sender.py "$WEBRTC_SRC/out/remote-desktop-linux" \
  --report build/linux-tests/synthetic-result.json
```

依赖 `xvfb-run`、`xauth`、`setxkbmap` 和 Python 标准库，创建一次临时受保护的Xvfb，不使用机器的真实桌面。测试独立观察X11按键、鼠标事件和图像像素，覆盖配对身份、口令、单会话、长度边界、分片期限、重启及失败次数/过期策略。合成测试不是产品虚拟桌面支持，不替代Android与真实Xorg桌面的功能验收。输入观察分别在US和German nodeadkeys布局执行，含AltGr符号；真实终端验收使用英文输入模式。

当前实现范围不包含Wayland、产品虚拟桌面、登录/锁屏控制、拖拽滚轮、声音、公网、中文或剪贴板同步。该实现移植自独立的 Linux 开发分支；主干尚未重新执行构建与真机验收，因此不能把分支原有的验证结论当作当前主干的验收结果。

## 独立构建 Android APK

```sh
bash scripts/linux/build-linux-controller-apk.sh "$WEBRTC_SRC" 4
```

仅泛化配对口令提示，保持包名、Activity和通信格式。使用独立的`remote_desktop_linux_android/`与`out/remote-desktop-linux-controller/`；APK仍名为`RemoteDesktopProbe.apk`。脚本沿用现有Android GN配置，未运行Chromium Android静态分析。安装到共用设备会替换同包应用，因此必须在Windows会话释放平板后执行。

## 连接诊断

`--serve` 在标准输出中追加 `connection_event=` JSON 行，包含递增序号、启动后的单调毫秒差及UTC毫秒时间。记录TLS读写/心跳、ICE、DTLS、数据通道、桌面权限和首次终止条件；每10秒及连接状态变化时尝试异步采集传输快照，记录请求序号、请求/回调时刻与报告时间；已有请求尚未完成的跳过和关闭时未完成请求均显式记录。结构化记录仅含固定标签与数字，不保存口令、证书、SDP、候选地址或输入文本。原视频统计格式与回执保持不变。首次终止原因与边界事件只在短临界区锁存，撤权先于日志写出；结构化输出使用最多256条的缓冲与非阻塞管道/套接字写出，不修改继承输出描述符的阻塞标志。结束记录携带累计丢事件数，末尾丢失标记未写出时也能识别证据不足；缺少丢失计数的旧诊断记录同样不被判为完整。

例如在自己的图形终端保存一次运行日志后分析：

```sh
mkdir -p .local/linux-diagnostics
"$WEBRTC_SRC/out/remote-desktop-linux/linux_sender" --serve \
  > .local/linux-diagnostics/session.log 2> .local/linux-diagnostics/session.stderr.log
python3 scripts/linux/analyze-connection.py .local/linux-diagnostics/session.log
python3 scripts/linux/test-connection-diagnostics.py
```

`first_observed_stop` 是程序最先观测到的终止触发点，不能直接当作根因。例如 `peer_disconnected` 仍须与该时段的ICE、TLS及控制端记录一起判断；后续本地关闭不会覆盖它。`root_cause` 保持 `undetermined`，由人工结合双方证据诊断。旧日志或缺少结束记录时分析命令返回2，不把证据不足当作通过。进程退出码沿用既有探针完成条件，退出0本身不代表断连正常或会话稳定。
