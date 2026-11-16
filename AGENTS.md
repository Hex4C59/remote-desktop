## 项目速览

Android 控制端（Java）查看并操作 Windows 被控端（C++）的局域网远程桌面原型，媒体链路复用固定版本原生 libwebrtc。当前是开发原型，功能与性能边界以 README 为准，目标架构与里程碑见 `ARCHITECTURE.md`。

## 变更边界

- 删除或改写看起来是有意为之的功能、代码或验证记录前，先问用户，不要自行按“冗余”或“未使用”处理。
- 依赖过旧导致的类型错误，通过升级依赖解决；不要为了消错而删除或降级代码。
- 小改动直接实施，并执行与该改动相称的检查。编译通过不代表真机链路可用，也不构成性能结论。

## 构建与运行

- 当前应用源码在 `apps/windows/src/`、`apps/android/src/main/` 和 `apps/linux/src/`；Linux 为移植代码，主干尚未重新构建与真机验收。目标公共模块见 ARCHITECTURE 第 5 节，`core/` 尚待逐步抽取；`probes/` 保留独立探针，不要复制旧实现覆盖应用源码。
- libwebrtc 与 depot_tools 在仓库外；固定版本见 `scripts/webrtc/webrtc-build-candidate.json`。升级版本必须重新验证两端构建与互通，不能只改清单。
- 原有 Windows/Android 构建将应用与探针组装到外部 checkout 的 `remote_desktop_probe/`；Linux 被控端与其独立 APK 入口使用 `remote_desktop_linux/`、`remote_desktop_linux_android/`。迁移源码时核对 ARCHITECTURE 5.2 的四套组装入口及两个 GN 配置，分别记录构建与互通结果，保持输出隔离。
- Android 没有 Gradle 工程，APK 由 libwebrtc 源码树的 GN 构建，不要新增 Gradle 工程替代现有流程。
- 根 `CMakeLists.txt` 只构建单帧桌面探针，不构建应用。桌面探针使用 VS2022 内置 CMake；WebRTC 构建使用 VS2026 与 Windows SDK 10.0.28000，两者不要混用。
- 桌面采集只在已登录、未锁屏的交互会话有效；SSH Session 0 的枚举结果或跳过不能当作桌面能力证据。
- 脚本默认输出到仓库 `build/`；不要写死已退役的 `D:\code\remote-desktop` 路径。

## 文档与证据

- 设计文档、架构参考、逆向分析报告放在 `docs/` 目录；目标架构仍以 `ARCHITECTURE.md` 为准。
- `.local/`、`build/` 被 Git 忽略；SDP、配对口令、截图、原始测量证据和主机信息不得提交。
- 软件处理耗时、操作到反馈帧耗时与物理画面延迟按 [ARCHITECTURE.md 8.0 术语](ARCHITECTURE.md#80-术语) 的名称区分，不互相替代，也不把短时探针写成 720p30 或性能验收通过。
- 构建通过只代表编译成功；合成视频、单帧采集和文件联调都不等于真机链路验收。
- Python 工具检查：`python -m unittest discover -s scripts/latency -p "test_*.py"`。

## 代码风格

- 注释用直白中文讲清“为什么”，不堆术语黑话；代码本身能说明的不要重复注释。
- 单行建议 80–100 字符，最多 120；超出时拆分逻辑，不要压缩可读性。
- 不写用户没要求的防御性代码和兼容层：只在入口校验一次输入，内部调用不重复校验，不吞异常，不留未使用的参数、分支或回退路径。

## 架构图绘制规范

架构图统一用 **SVG 源文件 + 导出 PNG** 双格式，放在 `assets/` 目录。SVG 是源，PNG 是渲染产物，两者同名（如 `architecture.svg` / `architecture.png`）。

SVG 必须遵循 `assets/architecture.svg` 的风格：

- 画布：`width="1160"`，`height` 按内容调整，`viewBox` 与宽高一致；背景 `#f6f8fb`。
- 字体：`Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif`。
- 外层容器：白色填充 `#ffffff`，圆角 `rx="16"`，描边 `#d7dee8` 宽 `1.5`；标题 17px 加粗 `#0f172a`。
- 功能模块：圆角 `rx="8"` 或 `rx="10"` 的矩形，用配色区分层级。
- 箭头：实线 `stroke="#64748b"` 用 `marker-end="url(#arrow)"`；虚线（如凭据签发）用 `#c08a3e` + `stroke-dasharray="5 5"`。
- 配色约定：
  - 蓝色系 `#e8f1ff` / `#dce9ff` 描边 `#8fb4e8` / `#6f9ee0`：通用组件
  - 橙色系 `#fff8ec` 描边 `#f0b45f`：控制面/信令/凭据
  - 绿色系 `#eafaf1` 描边 `#5fc08a`：媒体面/中继
  - 紫色系 `#f0e8ff` 描边 `#9b7fd8`：加密/服务
  - 红色系 `#fbe8e8` 描边 `#d88a8a`：崩溃/错误
- SVG 必须带 `<title>` 和 `<desc>`（无障碍），用 `role="img"` 和 `aria-labelledby`。

文档中引用图片的格式（参照 `ARCHITECTURE.md`）：

```markdown
[![图说明](assets/xxx.png)](assets/xxx.png "点击查看高清 PNG")

[查看高清 PNG](assets/xxx.png) · [SVG 源图](assets/xxx.svg)
```

从 `docs/` 下的文档引用时，路径前缀用 `../assets/`。

PNG 由 SVG 用浏览器 headless 模式导出：

```powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new --disable-gpu --screenshot="assets/xxx.png" --window-size=1160,860 "file:///.../assets/xxx.svg"
```

导出后核对 PNG 与 SVG `viewBox` 的宽高比一致。若使用 `--force-device-scale-factor=3` 导出高清图，
PNG 宽高应分别为 SVG 的 3 倍，文档中的尺寸标注使用 PNG 实际像素。
部分 Windows headless 版本的实际页面视口小于 `--window-size`；须检查页面视口覆盖完整 SVG，
必要时扩大窗口后按 SVG 像素尺寸裁剪，并复核文字、连线和图片底部未被截断。

## 提交

准备提交、整理暂存或编写提交信息时，按 [git-commit](.agents/skills/git-commit/SKILL.md) 执行。
