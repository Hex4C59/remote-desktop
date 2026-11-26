# 远程桌面控制协议 v1（局域网切片）

status: draft

状态：草案。M1 支持 Android 手机在同一局域网内远控 Windows 电脑，两端首次连接时现场配对。
目标架构与线程约束见 [架构总览](../architecture/overview.md) 与 [AGENTS.md](../../AGENTS.md)。

本文件只定义**控制消息**：JSON 信封、配对、授权、会话状态和媒体参数协商。
媒体数据、输入事件和可靠流分片走传输层的二进制通道，不在本文件内，也不能塞进 JSON。
传输层的二进制消息头格式见第 8 节。认证与通道绑定规则在本文件定义，线缆握手和可靠性策略由传输规格定稿。

与历史版本的差异：v1 不再使用 SDP/ICE/TURN，`offer`/`answer`/`ice` 三个消息已移除，
由 `media.offer` / `media.answer` 的简单参数协商替代。旧版本文档与向量在
Git 标签 `archive/m0-prototype` 中，不代表现行协议。

## 1. 信封

```json
{ "v": 1, "type": "media.offer", "session": "uuid", "negotiation": 1, "seq": 12, "payload": {} }
```

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `v` | int | 协议主版本，固定为 1。不认识的主版本拒绝。 |
| `type` | string | 见第 2 节。 |
| `session` | string 或 null | 会话 ID，UUIDv4。尚未建立会话时为 `null`。 |
| `negotiation` | int 或 null | 会话内的协商代次。M1 的媒体协商使用 1。非协商消息为 `null`。 |
| `seq` | int | 发送方在会话内单调递增，从 1 开始，不允许重复或倒退。 |
| `payload` | object | 各消息自己的字段。 |

`v`、`type`、`session`、`negotiation`、`seq` 与 `payload` 为必需字段。未知 `type` 返回 `unsupported_type`。
编码为 UTF-8 JSON，字段名用 ASCII。公钥的线缆编码为 SPKI DER，以不带填充的 base64url 传递。

信封上限：单条控制消息不超过 64 KiB。超限视为 `malformed_envelope` 并关闭连接，
不在应用层做分散重组。

## 2. 消息

| 消息 | 方向 | payload 字段 |
| --- | --- | --- |
| `pair.request` | 控制端 → 被控端 | `device_id`、`public_key` |
| `pair.accept` | 被控端 → 控制端 | `device_id`、`public_key` |
| `pair.confirm` | 被控端 → 控制端 | 无，表示被控端现场确认 |
| `pair.ready` | 控制端 → 被控端 | 无，表示控制端现场确认且已暂存对端身份 |
| `pair.complete` | 被控端 → 控制端 | 无，表示被控端信任记录已提交 |
| `pair.reject` | 双向 | `reason` |
| `session.challenge` | 被控端 → 控制端 | `challenge_id`、`expires_in_ms` |
| `session.request` | 控制端 → 被控端 | `challenge_id`、`permissions` |
| `session.accept` | 被控端 → 控制端 | `permissions`（实际授予） |
| `session.reject` | 被控端 → 控制端 | `reason` |
| `media.offer` | 被控端 → 控制端 | `codec`、`width`、`height`、`max_fps`、`max_bitrate_bps`、`keyframe_interval_frames`、`display_map_version` |
| `media.answer` | 控制端 → 被控端 | `accept`（bool）、`reason`（可选） |
| `session.ready` | 控制端 → 被控端 | 无，表示已渲染首帧。信封携带该帧的 `negotiation` |
| `input.prepare` | 被控端 → 控制端 | `input_epoch` |
| `input.ready` | 控制端 → 被控端 | `input_epoch` |
| `input.enabled` | 被控端 → 控制端 | `input_epoch` |
| `input.pause` / `input.resume` | 控制端 → 被控端 | `input_epoch` |
| `input.suspended` | 被控端 → 控制端 | `input_epoch`，表示该代次已关闭 |
| `ping` / `pong` | 双向 | `t`（发送方单调时钟毫秒，仅用于对端回显） |
| `bye` | 双向 | `reason` |
| `error` | 双向 | `code`、`in_reply_to_seq`、`message`（可选，仅调试） |

`permissions` 为无重复的字符串数组。v1 支持 `view`、`mouse`、`keyboard`，请求必须包含 `view`。
`bye.reason` 取值 `user`、`locked`、`disconnected`、`error`。
`pair.reject.reason` 取值 `user_denied`、`busy`、`code_mismatch`、`expired`、`storage_failed`、`identity_conflict`。
`session.reject.reason` 取值 `user_denied`、`busy`、`unsupported_permission`、`expired`、`not_interactive`。

`codec` 取值 v1 只允许 `h264-baseline`。`width`/`height`/`max_fps`/`max_bitrate_bps`/
`keyframe_interval_frames` 都是被控端给出的上限，控制端只能整体接受或不接受。
`display_map_version` 是当前会话的必需显示映射版本，取值为 `1` 到 `UINT32_MAX` 的整数。

## 3. 首次配对

配对与远控使用不同的连接模式。配对模式只能在被控端本机开启的窗口内启动，远控模式依照 §4 双向认证。

1. 被控端本机打开“允许配对”，显示一次性 6 位口令。窗口有效期 5 分钟，所有连接共享口令失败计数。
   认证库确认第 3 次口令失败时关闭整个窗口并作废口令。一个窗口最多允许一个配对流程进入现场确认。
2. 双方通过经评审的标准 PAKE 建立临时受保护通道。握手失败在本地报告并关闭连接。PAKE 选型及认证记录格式由传输规格定义。
   `pair.*` 只在临时通道内收发，`session` 和 `negotiation` 均为 `null`。双方交换 `pair.request` 和 `pair.accept`，
   并验证长期私钥持有证明。该证明和现场短码须由选定的配对机制绑定本次 PAKE 连接、双方角色及长期身份。
3. 两端显示与本次连接绑定的短码并要求用户确认。被控端本机确认后发送 `pair.confirm`。
   控制端收到它且本机已确认时，原子写入被控端的待激活身份，再发送 `pair.ready`。
4. 被控端收到当前配对流程的 `pair.ready` 后，取得最终提交许可并原子提交控制端身份，作废口令，并在当前流程仍有效时发送 `pair.complete`。
   控制端收到 `pair.complete` 后才可取得最终提交许可，原子激活本次记录。被控端等待可靠通道确认 `pair.complete` 送达后关闭临时通道，
   等待受配对窗口截止时间限制。被控端界面只报告本端登记结果。控制端收到 `pair.complete` 且本地激活成功后才报告配对成功。
5. 各端 Session 按尝试 ID 串行处理取消与最终提交许可。取消包括超时、连接中断和用户取消。
   取消先于许可时撤销该尝试，Writer 清除该尝试的暂存，包括迟到的暂存写入。许可先于取消时，Writer 可完成一次原子提交。
   写入成功保留本端已提交记录，写入失败清除本次暂存并报告失败。迟到结果只更新本地持久化状态，禁止继续已终止的协议流程。
   短码不一致或写入失败时终止本次尝试。受保护通道仍可用时发送对应的 `pair.reject`。
   被控端已登记而控制端尚未激活时，控制端提示重新现场配对。同一 `device_id` 与公钥可经重新现场确认幂等补齐信任，
   冲突的已登记公钥须先由本机用户移除。失败或取消不更改已有无关记录。

Windows 私钥受当前用户 DPAPI 保护。`device_id` 是安装时生成的随机 UUIDv4，与公钥绑定。

## 4. 授权与会话

### 4.1 质询

被控端完成远控连接双向认证后，才发送 `session.challenge`。信封中的 `session` 与 `negotiation`
均为 `null`。`challenge_id` 为随机 UUIDv4，有效期 30 秒，绑定到当前认证连接和对端身份。
每个连接最多保留一个质询。请求处理成功或失败均消费其引用的有效质询。质询过期后重新建立连接。

### 4.2 会话请求

1. 控制端在同一认证连接中用 `session.request` 回显质询并请求权限。被控端从连接取得设备身份。
   质询不存在、已使用、来自其他连接或已过期时返回 `session.reject`，`reason=expired`。
2. 被控端验证质询和权限并预留活动会话槽位。槽位不可用时返回 `busy`。在本地 UI 显示已认证身份及请求权限，
   等待被控端本机用户明确决定。待决项绑定原连接，连接失效或请求超时后忽略迟到的 UI 确认。
3. 本机用户须在 60 秒内批准本次会话和实际权限。授予集合为请求权限的子集且必须包含 `view`。
   拒绝或超时返回 `session.reject` 并释放待决槽位。桌面转为不可交互时返回 `not_interactive` 并退出待决授权。
4. 本机批准后生成新的随机会话 UUIDv4，并在同一已认证连接上发送 `session.accept` 及实际授权。
   批准前终止只作废待决授权并释放预留槽位，批准后终止按 001 §2.1 进入 `Ending`，清理确认后才释放槽位。
   被控端只在该连接上接受当前会话的后续控制和输入。任一方检测到身份或连接不匹配时关闭该连接，
   拒绝的记录不影响其他连接上的会话。授权随当前连接结束而失效。

### 4.3 媒体参数协商

1. `session.accept` 之后，被控端取得当前显示映射，再发 `media.offer`（`negotiation=1`），给出本次允许的上限和固定的 `display_map_version`。
2. 控制端检查本端是否支持 `codec`：支持则回 `media.answer{accept=true}`，否则回
   `media.answer{accept=false, reason=...}`，双方按 001 §2.1 结束已批准的会话。
3. 被控端收到接受后开始推流。控制端 Session 收到当前协商代次的有效首帧呈现回执后发送一次 `session.ready`。
   Windows 控制端见 [006 §2.2](../increments/006-windows-render-surface/spec.md#22-呈现结果与首帧)，Android 控制端见 [007 §2.2](../increments/007-android-controller/spec.md#22-解码呈现与首帧)。
   被控端在本机批准后 30 秒内收到有效确认则进入 Streaming，根据 §6 决定是否启用输入，否则结束会话。
4. M1 在显示映射变化时关闭会话。控制端须重新连接并获得本机授权，新会话通过新的 `media.offer` 获取当前映射版本。
   M1 每个会话只协商一次，保留 `negotiation` 字段用于校验当前代次。

## 5. 序号、代次与校验

### 5.1 顺序规则

- `seq` 由发送方在会话内递增，两个方向各自计数，接收端只校验严格递增。
- 会话建立前的消息（`session` 为 `null`）在连接内计数，断开后从 1 重来。
- `negotiation` 由被控端决定。M1 唯一一次 `media.offer` 使用 1，控制端的 `media.answer` 必须回显同一代次。
- 旧会话或不匹配代次的消息按 §5.2 校验，不并入当前会话。

### 5.2 校验顺序

接收方先验证传输保护、连接模式和记录所属通道。信封超限、非法 JSON、缺字段或 `seq` 小于 1 时，
在受保护通道上返回 `malformed_envelope` 后关闭连接。后续按以下顺序校验，命中即停止：

1. `v` 是否受支持 → `unsupported_version`。
2. 消息方向、连接模式和当前阶段是否允许该类型 → `not_authenticated`。
   配对通道按 §3 处理 `session=null` 的 `pair.*`。已认证且会话尚未建立的连接按 §4 处理
   `session.challenge`、`session.request`、`session.accept`、`session.reject`。
   `session.accept` 携带待接纳的新会话标识，只在本连接已有匹配的待决请求时建立会话。
3. 消息如属于活动会话，校验 `session` 属于当前连接且尚未结束 → `session_ended`。
4. 消息如携带协商代次，按 §4.3 校验当前或待决代次 → `stale_negotiation`。
5. 校验 `seq` 大于该作用域及方向已见最大值 → `stale_seq`。
6. 按当前阶段和权限校验消息负载 → `permission_denied`。二进制输入另外按 §6 校验代次及门禁。

| 情况 | 处理 |
| --- | --- |
| `malformed_envelope` | 回 `error` 后关闭连接。 |
| `unsupported_version` | 回 `error` 后关闭连接，不尝试降级。 |
| `not_authenticated` | 回 `error` 后关闭连接。 |
| `session_ended` | 静默丢弃并计数；对端可能还没收到 `bye`。 |
| `stale_negotiation`、`stale_seq` | 静默丢弃并计数，避免网络抖动时互相刷错误。 |
| 请求类消息权限不足 | 回 `error`，会话继续。 |

## 6. 会话流程

```text
双向认证 → 质询 → 请求 → 被控端本机批准 → accept
accept → media.offer / media.answer → 首帧渲染 → session.ready
有输入权限时：input.prepare → input.ready → input.enabled → 接收输入
```

- `input_epoch` 是单次会话内从 1 开始单调递增的 `uint32_t`。耗尽时结束会话，禁止回绕。
  控制端收到 `input.prepare` 后清空待发输入并停止采集。若窗口有焦点则回显 `input.ready`，否则对该代次请求暂停。
  被控端在本地门禁生效后才发 `input.enabled`。控制端须在有焦点且收到当前会话和代次的 `input.enabled` 后
  才采集并发送输入。仅查看会话不经过这些步骤。
- 控制端失去焦点时立即停止采集、清空待发输入，并经可靠 `control` 通道发送当前代次的 `input.pause`。
  被控端在连接、会话、方向、序号和当前代次校验后，通过独立接收槽交付有效暂停，普通信令队列满也须交付。
  Session 保持同一连接的接收顺序，复核当前状态，封闭该代次、清队列并启动按压清理，然后回 `input.suspended`。
  有效暂停或其应答无法入队时通过独立关断槽结束会话。被控端也可以本地发起暂停。
  控制端恢复焦点且收到该通知后可发送 `input.resume`。
  被控端收到有效恢复请求或本机决定恢复后，等待当前媒体首帧就绪、授权有效且清理确认，才用新代次发送 `input.prepare`。
  暂停可作用于已准备或已开启的代次。`input.resume` 只对当前已封闭的代次有效。
- 输入记录须携带当前会话、`input_epoch` 及通道内序号。旧会话、旧代次、重复、门禁未开启或类型未授予的事件
  丢弃并计数，不能为未来代次预排队。鼠标输入还须携带 `media.offer` 的显示映射版本，不匹配时丢弃并计数。
  队列溢出和事件过期按 001 §2.4 终止当前会话。
- 双向 `ping` / `pong` 保活，15 秒无有效应答视为断线。断线、本机撤权、锁屏、普通注入失败和主动结束均先关门禁。
  连接仍可用时发送 `bye`。按压清理由被控端本地执行，详见 001 §2.3。

## 7. 测试向量

每个向量给 JSON 输入与预期结果；用虚构凭据，不放真实口令、密钥或主机信息。
机器可读版本在 [vectors/envelope.json](vectors/envelope.json)，
每条带 `direction`，取值 `server->client`、`client->server` 或 `both`。
两端都实现全部消息类型的双向编解码；`direction` 只约束编码侧测试——
在自己不该发的方向发出即判失败，解码侧不按方向筛用例。

| 用例 | 预期结果 |
| --- | --- |
| 未配对端尝试建立远控连接 | 认证失败，不发 `session.challenge` |
| 配对时口令错误 | 本地报告并计入失败次数，失败连接关闭 |
| 配对两端短校验码不一致 | 无本次可用信任，受保护通道返回 `pair.reject`，reason=`code_mismatch` |
| 双向认证、有效质询与本机批准 | 建立会话，`accept` 带回新 UUID 和实际授权 |
| `v` 为 2 | `unsupported_version` 后关闭连接 |
| 未收到质询就发 `session.request` | `not_authenticated` |
| `challenge_id` 过期或已使用 | `session.reject`，reason=`expired` |
| 签名正确但请求 `clipboard` | `session.reject`，reason=`unsupported_permission` |
| `media.answer` 的 `accept` 为 false | 会话结束，`bye.reason=error` |
| 会话结束后再发 `media.answer` | 静默丢弃，不恢复旧会话 |
| `negotiation` 低于当前代次 | 静默丢弃 |
| 同一方向重复 `seq` | 静默丢弃 |
| 未启用当前 `input_epoch` 就发输入 | 丢弃并计数，无普通注入平台调用 |
| 控制消息超过 64 KiB | `malformed_envelope` 后关闭连接 |

## 8. 传输层要点

### 8.1 二进制消息头（草案）

控制消息之外的所有数据（视频帧分片、输入事件、可靠流分片）共用同一个定长消息头。
以下结构是**草案**，尚未实现；定稿前不得据此编写代码。

| 偏移 | 长度 | 字段 | 说明 |
| --- | --- | --- | --- |
| 0 | 1 | `version` | 传输层版本，v1 为 1 |
| 1 | 1 | `channel` | 通道号，见 [架构总览](../architecture/overview.md) 6.3 |
| 2 | 2 | `flags` | 位标志：bit0 帧起始、bit1 帧结束、bit2 关键帧 |
| 4 | 4 | `payload_len` | 本消息负载字节数，不含消息头 |
| 8 | 8 | `stream_seq` | 通道内递增序号，用于重组与丢包检测 |
| 16 | 8 | `send_timestamp_ns` | 发送方单调时钟，仅用于统计，不参与排序判定 |

固定头部 24 字节，网络字节序。负载上限按通道约定：视频分片与可靠流分片各有上限，
超限视为协议错误。

待定（定稿前必须解决）：

- 加密后 `payload_len` 是否为密文长度，以及是否包含认证标签。
- `stream_seq` 的可接受重排窗口大小。
- 是否需要独立的 `frame_id` 区分同一通道内的帧边界，
  或完全依赖 `flags` 的帧起始/结束位。
- 校验方式：逐消息校验还是依赖传输层完整性。

### 8.2 与控制消息的关系

- 远控使用支持新鲜会话密钥、双向身份验证和完整性保护的标准传输安全机制。双方须将握手中验证的
  长期公钥与各自已提交的信任记录匹配，检查对端角色和协议版本。应用数据在握手确认后接收，禁止早期数据或明文回退。
- `control`、`input-key`、`pointer`、`video` 属于同一认证传输上下文。传输层在交付前验证通道、记录序号
  和所属连接，应用层再验证会话或输入代次。未验证的分片不得进入会话重组或媒体、输入队列。
- M1 保留架构 D1 的单 UDP 关联与逻辑通道目标。线缆握手、分片和可靠性的具体契约由传输规格定义。
  独立媒体或输入加密握手不能替换当前会话的认证上下文。控制消息分片服从控制通道和发送队列各自的上限。
- 保活由 `ping`/`pong` 在应用层完成，传输层心跳只用于探测链路活性，不参与会话状态判定。

## 9. 待定

- 权限位与后续能力如何扩展，是否需要版本化能力表。
- 加密库选型、PAKE 配对方案及握手消息的具体形状（受 AGENTS.md §3 依赖审批约束）。
  v1 配对须现场核对短码，其他配对方式需另立规格。
- 私钥轮换与“换机但沿用同一 `device_id`”的处理，v1 一律按新设备重新配对。
- Android 控制端按 [007](../increments/007-android-controller/spec.md) 通过 JNI 复用共用 C++ 会话与消息编解码。本地表面代次仅用于筛选回执，无对应线缆字段。
