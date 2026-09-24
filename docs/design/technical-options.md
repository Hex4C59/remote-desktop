# 第一版技术路线调研

日期：2026-09-22。依据已确认的 Android → Windows、局域网、一个月、RTC 校招展示范围。后续状态：用户已接受优先验证原生 libwebrtc 及 2–3 个工作日的构建/互通期限，见 [ADR 0003](../adr/0003-validate-native-libwebrtc-first.md)。其余细节仍为研究建议；尚待原型执行范围的最终确认。

## 建议结论

**建议优先验证两端 native libwebrtc 的视频轨道 + DataChannel 路线。** 这是结合项目期限作出的工程判断：把有限时间用于采集接入、输入控制、队列与测量，复用视频传输和接收引擎。前提是先证明 Windows 库和 Android AAR 的构建、链接、真机互通可复现；不能把“采用 WebRTC”当作已经解决集成。

**libdatachannel + 自接 Media Foundation / MediaCodec 是候选替代方案，但不应被描述成更省事的完整视频引擎。** 它让编解码与网络反馈的连接更显式，也意味着更多集成责任；以下比较是推断其工程代价，而非实测工时。

## 能力与工程代价

| 维度 | native libwebrtc：Windows C++ + Android Java | libdatachannel + 自接编解码 |
| --- | --- | --- |
| 网络与媒体引擎 | 源码包含 Google 拥塞控制、码率/发送节奏控制及视频接收/NACK 路径；实际启用受配置和协商影响。[拥塞控制](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/goog_cc_network_control.cc)、[接收链路](https://webrtc.googlesource.com/src/+/refs/heads/main/video/video_receive_stream2.cc) | 提供 WebRTC DataChannel、媒体传输和 WebSocket；示例自行把 H.264 packetizer、RTCP sender report、NACK responder 接成链。[项目说明](https://github.com/paullouisageneau/libdatachannel)、[示例](https://github.com/paullouisageneau/libdatachannel/blob/master/examples/streamer/main.cpp) |
| Android 解码显示 | `DefaultVideoDecoderFactory` 组合硬件/软件解码器；`AndroidVideoDecoder` 使用 MediaCodec；`SurfaceViewRenderer` 是 VideoSink，内部使用 EGL renderer。并非每台设备都保证某种硬解可用。[工厂](https://webrtc.googlesource.com/src/+/main/sdk/android/api/org/webrtc/DefaultVideoDecoderFactory.java)、[解码](https://webrtc.googlesource.com/src/+/main/sdk/android/src/java/org/webrtc/AndroidVideoDecoder.java)、[显示](https://webrtc.googlesource.com/src/+/refs/heads/main/sdk/android/api/org/webrtc/SurfaceViewRenderer.java) | libdatachannel 的帧回调交付解包后的媒体帧；应用还要配置 MediaCodec、提交压缩数据、处理参数集/时间戳/输出 Surface 和生命周期。[帧 API](https://github.com/paullouisageneau/libdatachannel/blob/master/DOC.md)、[MediaCodec](https://developer.android.com/reference/android/media/MediaCodec) |
| 反馈与码率 | 复用已有拥塞控制，对外记录实际编码/发送/接收行为，避免宣称算法是自己实现。[源码](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/goog_cc_network_control.cc) | 有 REMB 请求/回调、pacing、PLI 等接口；有这些组件不等于已形成自适应编码闭环。应用需决定并接通反馈→编码码率/关键帧等策略，不能把 DataChannel 的拥塞控制等同于视频自适应。[API](https://github.com/paullouisageneau/libdatachannel/blob/master/DOC.md) |
| Windows 编码接入 | 候选先使用选定构建可用的编码器，把自采集帧送入视频源；不要未经验证就承诺 H.264 硬编或零拷贝。具体 codec/build flags 留给原型确认。 | 显式接入 Media Foundation H.264 MFT：配置输入输出类型、码率和低延迟属性，响应关键帧请求。硬件 MFT 的可选属性需查询验证。[H.264 encoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder) |
| 构建入口 | 官方 Android 流程要求 Linux，使用 depot_tools/GN/Ninja，并提供 AAR 打包脚本。Windows 前置工具链指向 Chromium 构建文档。[Android](https://webrtc.googlesource.com/src/+/main/docs/native-code/android/)、[AAR](https://webrtc.googlesource.com/src/+/master/tools_webrtc/android/build_aar.py)、[前置环境](https://webrtc.googlesource.com/src/+/main/docs/native-code/development/prerequisite-sw/)、[Windows](https://chromium.googlesource.com/chromium/src/+/main/docs/windows_build_instructions.md) | 官方有 CMake/MSVC 和 MinGW 构建入口；Android 纳入支持平台。若 Android 也选此库，项目仍需连接本地库与平台 UI/MediaCodec 的接口。[构建](https://github.com/paullouisageneau/libdatachannel/blob/master/BUILDING.md)、[支持平台](https://github.com/paullouisageneau/libdatachannel) |

构建建议（推断）：选定 commit 后锁定工具链、编译参数、CPU ABI、产物来源及校验值；先用最小程序验证链接，再展开应用。若采用第三方预编译包，单独审查来源和可复现性，不能默认存在可直接用的官方 Maven/Windows 二进制组合。旧版入门页的工具版本不要直接当作当前要求，须与所选源码 revision 的构建配置核对。

## 两条路线共有的 Windows 边界

- Desktop Duplication 提供桌面帧与移动/脏矩形信息；图像旋转及光标是否独立于画面需要处理。候选第一版先传完整缩放帧，避免先做脏矩形编码优化。[Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api)
- `DuplicateOutput` 可能因桌面访问权限、会话断开或模式不支持等失败；安全桌面访问有权限限制。应将锁屏/桌面切换失败转成可见断线或错误，不能假定采集永远有效。[DuplicateOutput](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput)
- `SendInput` 受 UIPI 限制，只能注入同等或更低完整性级别的进程，且不会自动重置已有按键状态。因此首版验收建议使用普通权限终端，并跟踪本会话按下的键，在断线时释放。[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- 上述限制不构成新增的管理员权限或登录界面支持要求；项目已经明确排除锁屏控制。

## 待用户确认后的原型检查点

以下是待批准的验证建议，不是当前开始执行的计划。

1. **构建检查点**：Windows 原生程序与 Android APK 可重建、可运行；记录库 revision、工具链、ABI 和实际 codec。建议给构建/互通探索设 2–3 个工作日预算，失败后重新评估路线，而非自动换方案。
2. **互通检查点**：局域网传测试画面到真机，并由 DataChannel 返回一个带序号的测试事件；确认信令、媒体、控制三者分别有可诊断日志。
3. **设备检查点**：真实桌面 720p 候选 30 FPS，Android 实际解码显示；检查色彩、方向、光标、终端文字可读性及 CPU 占用。静止桌面不必伪造 30 个变化帧，帧率验收用持续变化场景。
4. **交互检查点**：手机输入英文/符号和 Ctrl+C，断线/切后台后不遗留按键状态；普通权限终端完成一次编辑并运行。
5. **测量检查点**：分别记录采集、编码、发送、解码、显示各层能取得的统计；跨设备时钟不能直接相减当单向延迟。端到端延迟先考虑同一外部录像同时拍摄源屏与手机，输入反馈另设可见事件实验；方法与误差需写入报告。
6. **弱网检查点**：分别限制带宽、增加延迟、引入丢包；确认干预确实经过媒体路径，记录恢复过程。选择实际发现的一个瓶颈做前后对照，不预设一定由应用队列导致。

原型通过不等于安全设计已完成。临时口令的有效期、尝试限制、信令与媒体身份绑定仍需设计；加密传输本身不能替代用户授权。这是待设计事项，不在本次调研中指定密码学方案。
