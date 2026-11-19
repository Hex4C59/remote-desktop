# 第三方产品观察记录

本目录存放对**外部软件**的调查：安装包文件清单、组件与进程职责、二进制字符串、
公开源码交叉核对。这些是证据记录，不是本项目的设计文档。

## 与 `docs/` 其余文件的关系

| 目录 / 文件 | 性质 | 是否约束实现 |
| --- | --- | --- |
| `specs/` | 功能级行为契约 | 是。`status: approved` 才可动工 |
| `docs/architecture.md`、`threading.md`、`protocol.md`、`platform-abstraction.md` | 架构与接口契约 | 是，由 `ctest` 中的 `arch.layers` 检查 |
| `docs/references/`（本目录） | 对外部产品的观察 | **否** |

放进本目录的内容没有以下效力：

- 不能作为技术选型依据。看到 RustDesk 用 Rust，不等于本项目要用 Rust。
- 不能作为性能或能力证据。DLL 大小、字符串出现次数都不衡量功能覆盖。
- 不被 `specs/` 或 `src/` 引用。任何实现决策都不应指向本目录。

## 现有记录

| 文件 | 对象 | 观察时间 | 图 |
| --- | --- | --- | --- |
| [RUSTDESK-REFERENCE.md](RUSTDESK-REFERENCE.md) | RustDesk 1.4.9+67（build 29722256） | 2026-11-16 | `assets/references/rustdesk-architecture.*` |
| [CROSS-PLATFORM-REFERENCE.md](CROSS-PLATFORM-REFERENCE.md) | 网易 UU 远程 4.46.0.4716 | 2026-11-16 | `assets/references/uu-remote-architecture.*` |

## 写新记录的约定

1. 文件名 `<产品>-REFERENCE.md`，全大写后缀与其他文件保持一致。
2. 开头必须有「性质：第三方产品观察记录，不是本项目契约」的说明块。
3. 观察时间、版本号、安装路径写清楚；无法确认与某个 commit 对应的要明说。
4. 区分「观察到的事实」与「由此推测的结论」，两者不可混写。
5. 图放 `assets/references/`，`.drawio` 或 `.svg` 源文件与同名 PNG 并存。
6. 许可证与复用边界要写明（例如 RustDesk 主仓库为 AGPL-3.0）。
