# Android 控制端

源码按 Android 常用目录组织：

```text
src/main/
  AndroidManifest.xml
  java/dev/remotedesktop/probe/
    ProbeActivity.java
    PairingConnection.java
    VideoStatistics.java
```

`ProbeActivity.java` 负责界面、视频显示、触屏/键盘输入和会话管理；`PairingConnection.java` 负责配对与信令；`VideoStatistics.java` 负责视频统计。

当前仍使用 libwebrtc 源码树的 GN 构建，没有独立 Gradle 工程。Linux 构建入口为 `scripts/linux/build-webrtc-probe.sh`，输出仍为外部 libwebrtc checkout 的 `out/remote-desktop-arm64/apks/RemoteDesktopProbe.apk`。生成目录映射见 [应用源码说明](../README.md)。

本次迁移保留 `dev.remotedesktop.probe` 包名、Activity 名称及 APK 名称，现有安装和联调入口继续使用这些名称。
