# 局域网临时配对与信令（任务02）

## 认证与身份绑定

复用BoringSSL和Android平台TLS，不自制密码算法。每次启动`sender --serve`生成临时P-256自签名证书与128位随机凭据；配对口令为`base64url(SHA-256(证书DER) || 随机凭据)`，共64个字符，无填充。口令仅显示在Windows交互窗口，不写标准输出、日志、文件或Android保存状态。

Android以口令中的完整SHA-256指纹作为本次连接的信任锚，同时检查证书有效期；不会接受任意证书。随后在TLS1.2连接内发送完整口令，被控端用常量时间比较校验。随机凭据提供控制端授权，证书指纹提供被控端身份验证。这里没有公有CA或DNS身份；IP仅用于定位，由用户从可信Windows屏幕手动转录的口令决定信任。

长口令是当前无需账户、预装证书或额外确认步骤的取舍；不声称它是易输入的六位PIN。自签证书和口令每次启动更新，认证窗口为5分钟，最多10次失败握手/认证。成功后口令消耗为一个会话，窗口隐藏，额外TLS连接只得到`busy`。会话结束后程序退出；再次连接须重启并取得新口令，应用也须从最近任务移除后重新打开。完整手动重连体验属于任务05。

只有认证成功后才创建桌面帧源及PeerConnection。该唯一TLS连接交换双方的SDP（包含DTLS证书指纹）和ICE候选，libwebrtc据此验证媒体DTLS身份，并建立SRTP视频与DTLS/SCTP DataChannel。不存在另一个未认证的网络SDP入口，无法用另一个控制连接替换当前会话描述。开发文件探针由独立CLI模式显式启动，不监听产品信令端口。

## 信令与边界

Windows监听TCP18443，Android暂支持手动IPv4地址，可带端口。TLS1.2为Android与Windows共同使用版本；被控端允许TLS1.2以上。Wi-Fi选路沿用现有实现。

消息为四字节大端长度加UTF-8正文，长度1–65536字节。类型为`auth\n<code>`、`accepted`、`denied`、`busy`、`offer\n<sdp>`、`answer\n<sdp>`、`ice\n<mid>\n<index>\n<candidate>`、`ping`与`pong`。正文不写入运行日志。

SDP设置完成即可发送，ICE每次回调持续发送，不依赖首次COMPLETE或候选静默快照。对端描述尚未应用时暂存最多128条候选，之后应用；已应用描述后晚到候选直接进入同一PeerConnection。重复answer/offer、未知消息、非法候选或队列溢出结束会话。

网络与采集/RTC线程分开，收发消息队列及Android待处理信令回调每个最多128条，每条最多64KiB；没有无限内存积压。TLS握手、Windows消息读写有5秒绝对期限；Android连接/握手超时5秒，分片接收期限5秒。手机每5秒发送心跳，20秒没有接收消息则结束信令。不是完整断线恢复保证。任务03已在授权DataChannel中开放[触屏定位与成对左键点击](pointer-input.md)，任务04的键盘状态及任务05的完整重连尚未实现。

## 运行

Windows交互桌面运行：

```powershell
D:\tools\remote-desktop\webrtc-windows\src\out\remote-desktop-win\sender.exe --serve
```

允许该程序在实际使用的局域网防火墙配置下通信。Android从应用图标启动，输入电脑IPv4地址和Windows窗口中的口令，点击连接。正常使用无需USB、ADB或SDP文件。首次连接失败后从最近任务移除应用，再打开重试；5分钟到期或10次失败后重启被控端。

开发验收脚本`test-pairing.ps1 -Address <IPv4>:18443`在Windows交互桌面读取当次显示的口令，用ADB驱动正常输入框，分别尝试错误证书指纹、错误口令、正确口令和第二条TLS连接，再验证切后台时的清理；ADB仅承担UI驱动和证据回收。截图与SDP可能含私有内容，保留在忽略的build目录，公开结果只保留摘要。

## 参考

- [Android TLS与自定义信任校验](https://developer.android.com/privacy-and-security/security-ssl)：此处短期、每次显式建立的设备信任与长期固定公有服务证书不同，不能直接推广为通用HTTPS信任管理。
- [WebRTC连接与Trickle ICE](https://webrtc.org/getting-started/peer-connections)：项目承担信令传递，持续转发候选。
- BoringSSL接口以固定WebRTC依赖中的`openssl/ssl.h`、`x509.h`和`rand.h`为准；版本沿用`webrtc-build-candidate.json`。
