# Windows 被控端

C++ 源码位于 `src/`：

- `sender.cpp`：程序入口、WebRTC 视频发送与会话流程。
- `frame_source.h`、`desktop_source.cpp`：视频源接口与 Windows 桌面采集。
- `pairing_server.h/.cpp`：地址与临时口令配对、信令。
- `pointer_input.h/.cpp`、`physical_coordinates.h`：鼠标输入与物理坐标处理。
- `keyboard_input.h/.cpp`：字符与终端按键输入。
- `video_statistics_log.h/.cpp`：接收并保存控制端的视频统计。

构建入口为 `scripts/windows/build-webrtc-probe.ps1`，输出仍为外部 libwebrtc checkout 的 `out/remote-desktop-win/sender.exe`。生成目录及共享 GN 配置见 [应用源码说明](../README.md)。

合成视频模式使用 `probes/webrtc/pattern_source.cpp`；独立的单帧桌面采集探针仍位于 `probes/windows_desktop.cpp`。
