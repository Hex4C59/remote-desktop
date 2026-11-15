## 项目速览

Android 控制端（Java）查看并操作 Windows 被控端（C++）的局域网远程桌面原型，媒体链路复用固定版本原生 libwebrtc。当前是开发原型，功能与性能边界以 README 为准。

## 变更边界

- 删除或改写看起来是有意为之的功能、代码或验证记录前，先问用户，不要自行按“冗余”或“未使用”处理。
- 依赖过旧导致的类型错误，通过升级依赖解决；不要为了消错而删除或降级代码。
- 小改动直接实施，并执行与该改动相称的检查。编译通过不代表真机链路可用，也不构成性能结论。

## 构建与运行

- 应用源码只在 `apps/windows/src/` 和 `apps/android/src/main/`；`probes/` 保留独立探针，不要复制旧实现覆盖应用源码。
- libwebrtc 与 depot_tools 在仓库外；固定版本见 `scripts/webrtc/webrtc-build-candidate.json`。升级版本必须重新验证两端构建与互通，不能只改清单。
- 构建脚本把 `apps/windows/src/`、`apps/android/src/main/`、`probes/webrtc/*.cpp` 和 `scripts/webrtc/BUILD.gn` 组装到外部 checkout 的 `remote_desktop_probe/`。改路径时同步两个构建脚本和 GN 配置。
- Android 没有 Gradle 工程，APK 由 libwebrtc 源码树的 GN 构建，不要新增 Gradle 工程替代现有流程。
- 根 `CMakeLists.txt` 只构建单帧桌面探针，不构建应用。桌面探针使用 VS2022 内置 CMake；WebRTC 构建使用 VS2026 与 Windows SDK 10.0.28000，两者不要混用。
- 桌面采集只在已登录、未锁屏的交互会话有效；SSH Session 0 的枚举结果或跳过不能当作桌面能力证据。
- 脚本默认输出到仓库 `build/`；不要写死已退役的 `D:\code\remote-desktop` 路径。

## 文档与证据

- 原 `docs/`、`.scratch/` 已移除，不恢复、不引用；新增设计或验证记录前先问用户放在哪里。
- `.local/`、`build/` 被 Git 忽略；SDP、配对口令、截图、原始测量证据和主机信息不得提交。
- 软件处理耗时、操作到反馈帧耗时与物理画面延迟按 `CONTEXT.md` 的名称区分，不互相替代，也不把短时探针写成 720p30 或性能验收通过。
- 构建通过只代表编译成功；合成视频、单帧采集和文件联调都不等于真机链路验收。
- Python 工具检查：`python -m unittest discover -s scripts/latency -p "test_*.py"`。

## 代码风格

- 注释用直白中文讲清“为什么”，不堆术语黑话；代码本身能说明的不要重复注释。
- 单行建议 80–100 字符，最多 120；超出时拆分逻辑，不要压缩可读性。
- 不写用户没要求的防御性代码和兼容层：只在入口校验一次输入，内部调用不重复校验，不吞异常，不留未使用的参数、分支或回退路径。

## 提交

准备提交、整理暂存或编写提交信息时，按 [git-commit](.agents/skills/git-commit/SKILL.md) 执行。
