// 职责：项目公共接口的版本标识与基本类型占位。
// 线程归属：无（纯头文件，无状态）。
//
// 这里只放跨模块共享的最小定义。采集、注入、会话等接口按
// docs/platform-abstraction.md 逐个加入，加入前先改该文档与 specs/。
// 当前没有任何业务实现；本文件存在的目的是让 include/ 在构建中真实参与编译，
// 避免"头文件无人引用、改坏了也没人发现"。

#pragma once

#include <cstdint>

namespace rd {

// 公共接口的版本号。接口契约发生不兼容变更时递增，并同步 docs/ 与 specs/。
inline constexpr std::uint32_t kAbiVersion = 1;

// 会话标识。由被控端在授权通过后分配，跨消息保持一致。
using SessionId = std::uint32_t;

// 输入代次。每次暂停后恢复输入都会分配新值，旧代次的输入一律丢弃。
using InputEpoch = std::uint32_t;

}  // namespace rd
