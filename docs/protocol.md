# 远程桌面控制协议 v1（局域网切片）

status: draft

状态：草案，无实现。范围是 M1 局域网纵向切片：Windows 被控端 + 控制端，同一局域网，现场配对一次。
目标架构与线程约束见 [architecture.md](architecture.md) 与 [AGENTS.md](../AGENTS.md)。

本文件只定义**控制消息**：JSON 信封、配对、授权、会话状态和媒体参数协商。
媒体数据、输入事件和可靠流分片走传输层的二进制通道，不在本文件内，也不能塞进 JSON。
传输层的二进制消息头格式见第 8 节；握手、加密与可靠性策略待传输规格确定。

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
| `negotiation` | int 或 null | 会话内的协商代次，首次为 1，重新协商时递增。非协商消息为 `null`。 |
| `seq` | int | 发送方在会话内单调递增，从 1 开始，不允许重复或倒退。 |
| `payload` | object | 各消息自己的字段。 |

编码：UTF-8 JSON，字段名用 ASCII；二进制一律 base64url 且不带填充。
公钥与临时公钥用 SPKI DER，签名用 ASN.1 DER，两者都按 base64url 传递。

信封上限：单条控制消息不超过 64 KiB。超限视为 `malformed_envelope` 并关闭连接，
不在应用层做分散重组。

## 2. 消息

| 消息 | 方向 | payload 字段 |
| --- | --- | --- |
| `pair.request` | 控制端 → 被控端 | `challenge_id`、`device_id`、`public_key`、`ephemeral_key`、`password_proof`、`signature` |
| `pair.accept` | 被控端 → 控制端 | `device_id`、`public_key`、`ephemeral_key`、`password_proof`、`signature` |
| `pair.confirm` | 控制端 → 被控端 | 无；表示用户已核对短校验码 |
| `pair.reject` | 被控端 → 控制端 | `reason` |
| `session.challenge` | 被控端 → 控制端 | `challenge_id`、`nonce`（32 字节）、`expires_in_ms` |
| `session.request` | 控制端 → 被控端 | `challenge_id`、`device_id`、`permissions`、`signature` |
| `session.accept` | 被控端 → 控制端 | `permissions`（实际授予） |
| `session.reject` | 被控端 → 控制端 | `reason` |
| `media.offer` | 被控端 → 控制端 | `codec`、`width`、`height`、`max_fps`、`max_bitrate_bps`、`keyframe_interval_frames` |
| `media.answer` | 控制端 → 被控端 | `accept`（bool）、`reason`（可选） |
| `session.ready` | 控制端 → 被控端 | 无；表示已连上并渲染出首帧 |
| `input.ready` | 控制端 → 被控端 | `input_epoch` |
| `ping` / `pong` | 双向 | `t`（发送方单调时钟毫秒，仅用于对端回显） |
| `bye` | 双向 | `reason` |
| `error` | 双向 | `code`、`in_reply_to_seq`、`message`（可选，仅调试） |

`permissions` 用字符串数组，v1 只有 `view`、`mouse`、`keyboard`。
`bye.reason` 取值：`user`、`locked`、`disconnected`、`error`。
拒绝类 `reason` 取值：`user_denied`、`busy`、`bad_signature`、`unsupported_permission`、
`bad_password`、`code_mismatch`、`expired`。

`codec` 取值 v1 只允许 `h264-baseline`。`width`/`height`/`max_fps`/`max_bitrate_bps`/
`keyframe_interval_frames` 都是被控端给出的上限，控制端只能整体接受或不接受，不能部分降级——
部分降级由被控端在运行中自适应完成，见 architecture.md 5.1。

## 3. 首次配对

未配对时被控端手里没有控制端公钥，验证不了任何签名，所以首次连接只走配对消息，不进会话授权。

1. 用户在 Windows 上打开“允许配对”，屏幕显示 6 位配对口令。窗口 5 分钟，口令单次有效，
   累计 3 次校验失败即关闭窗口并作废口令。
2. 连接建立后被控端先下发 `session.challenge`（规则见 4.1），质询有效期 30 秒，
   过期由控制端重取；重取不计入失败次数。
3. 控制端生成临时 P-256 密钥对，用口令与质询 `nonce` 派生证明密钥：
   `PBKDF2-HMAC-SHA256(口令, salt=nonce, 100000 次迭代)`。
   `pair.request` 带 `challenge_id`、`device_id`、`public_key`（长期身份公钥）、`ephemeral_key`、
   `password_proof`、`signature`。口令本身不上网络，只提交证明：

   ```text
   规范化字节 = "rd-pair-v1|request|" + 长度前缀的 challenge_id、nonce、device_id、public_key、ephemeral_key
   password_proof = HMAC-SHA256(证明密钥, 规范化字节)
   signature      = 长期私钥对同一段规范化字节签名（算法见 4.2）
   ```

   两段都只覆盖请求方此刻已知的字段，不包含还没收到的受理方信息。
4. 被控端用同一算法重算 `password_proof` 比对，同时验质询与签名。口令不对就计数并回
   `pair.reject`，`reason=bad_password`。
5. 通过后被控端生成自己的临时 P-256 密钥对，回 `pair.accept`：`device_id`、`public_key`、
   `ephemeral_key`、`password_proof`、`signature`。这两段改为覆盖
   `"rd-pair-v1|accept|"` + 请求方那五个字段 + 受理方的 `device_id`、`public_key`、`ephemeral_key`；
   不包含任何 proof 与签名本身，避免循环依赖。控制端收到后才算得出，可照验。
6. 双方以完整 transcript（两份 `device_id`、两份长期公钥、两份临时公钥、质询 `nonce`，
   前缀 `"rd-pair-v1|sas|"`，同样用长度前缀）的 SHA-256 算 6 位短校验码：
   取摘要前 4 字节按大端读成整数，对 1000000 取余，左侧补零成 6 位。
   两端各显示一份，用户在被控端本机核对一致后点确认，被控端回 `pair.confirm` 完成后写入信任名单。
7. 确认后被控端原子写入信任名单，控制端保存被控端身份；配对窗口立即关闭，该质询作废。
   数字不一致或超时：不落盘任何信任，回 `pair.reject`，`reason=code_mismatch`。

口令和短校验码都不上网络：传的只有公钥、临时公钥和两个证明。
每次配对都生成新的临时密钥，口令与短校验码都只用一次。

6 位口令只有约 20 位熵，抓一次握手就能离线枚举一百万个值，所以它不承担密码学根基：
一次性、5 分钟窗口、3 次失败作废，即使被猜出也换不到信任。真正挡中间人的是短校验码：
攻击者不在现场，就无法让两台真机屏幕显示同一组数字。

存储：Windows 私钥用当前用户的 DPAPI 保护后放本地应用数据目录；其他平台用各自系统密钥库
（P-256，签名用途）。长期公钥与信任记录按平台惯例明文保存。
`device_id` 是安装时生成的随机 UUIDv4，与公钥绑定，不取自硬件。

## 4. 授权与会话

### 4.1 质询

质询是被控端临时给出的随机数（`nonce`），只能用来回应一次请求，用过或过期即作废。

1. 连接建立后被控端主动下发 `session.challenge`，此时 `session` 与 `negotiation` 均为 `null`。
2. 被控端生成 `challenge_id`（UUIDv4）与 32 字节随机 `nonce`，有效期 30 秒。
   同一连接最多保留 1 个未使用质询，新质询覆盖旧质询。

### 4.2 会话请求

1. 控制端组装签名输入，用设备私钥签名，发 `session.request`。
   签名算法是 ECDSA P-256 / SHA-256，`signature` 是 ASN.1 DER 的 base64url（约 70–72 字节）。
   签名输入用长度前缀，避免字段内容里正好有分隔符时拼接出歧义：

   ```text
   签名输入 = "rd-session-v1"
            + "|challenge_id=" + 字节长度 + ":" + challenge_id
            + "|nonce="        + 字节长度 + ":" + nonce
            + "|device_id="    + 字节长度 + ":" + device_id
            + "|permissions="  + 字节长度 + ":" + 权限按字典序排序后逗号连接
   ```

   长度是 UTF-8 字节数的十进制写法；`nonce` 用 base64url 文本，不用原始字节。
2. 被控端校验质询存在且未过期、签名有效、权限在允许范围：
   - 通过：作废该质询，生成新会话 UUIDv4，放入此后所有消息的 `session` 字段，发 `session.accept`。
   - 不通过：作废该质询（成功与否都作废），发 `session.reject`。
3. v1 不签发 token，权限随会话存续；token 与续期属后续里程碑。

### 4.3 媒体参数协商

1. `session.accept` 之后，被控端发 `media.offer`（`negotiation=1`），给出本次允许的上限。
2. 控制端检查本端是否支持 `codec`：支持则回 `media.answer{accept=true}`，否则回
   `media.answer{accept=false, reason=...}` 并结束会话。
3. 被控端收到接受后开始推流。控制端渲染出首帧后发 `session.ready`，随后被控端分配
   `input_epoch=1`，等待 `input.ready`。
4. 重新协商（改分辨率、帧率或码率上限）沿用同一对消息，`negotiation` 加 1。
   协商期间输入不禁用，但旧代次消息一律按 5.1 的规则处理。

## 5. 序号、代次与校验

### 5.1 顺序规则

- `seq` 由发送方在会话内递增，两个方向各自计数，接收端只校验严格递增。
- 会话建立前的消息（`session` 为 `null`）在连接内计数，断开后从 1 重来。
- `negotiation` 由被控端决定：首次 `media.offer` 为 1，每次重新协商加 1。
  控制端的 `media.answer` 必须回显同一个代次。
- 重新协商期间的旧代次消息一律丢弃，不并入新代次。

### 5.2 校验顺序

信封本身解析失败（非法 JSON、缺字段、`seq` 小于 1、超过 64 KiB）直接回 `malformed_envelope`
并关闭连接，不进入下面的顺序。之后的检查命中即停，不再往下判断：

1. `v` 是否为受支持版本 → `unsupported_version`。
2. 连接是否已认证（未配对时只接受质询与 `pair.*`，已配对但未授权时只接受质询与
   `session.request`）→ `not_authenticated`。
3. `session` 是否存在且未结束 → `session_ended`。
4. `negotiation` 是否为当前代次 → `stale_negotiation`。
5. `seq` 是否大于该方向已见最大序号 → `stale_seq`。
6. 该消息所需权限是否已授予 → `permission_denied`。

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
被控端: challenge → 收到 request → accept/reject
accept 后被控端发 media.offer（negotiation=1）
控制端: media.answer → 收流 → 首帧后发 session.ready
被控端: 分配 input_epoch=1，等待 input.ready
控制端: 确认 epoch 后发 input.ready，此后才允许输入
双向: ping/pong 保活，15 秒无有效应答视为断线
任一方结束都发 bye，本地释放输入与按压状态
```

`input_epoch` 由被控端分配，每次暂停后恢复输入都分配新值；会话或 epoch 变化时
控制端清空待发旧输入。

## 7. 测试向量

每个向量给 JSON 输入与预期结果；用虚构凭据，不放真实口令、密钥或主机信息。
机器可读版本在 [vectors/envelope.json](protocol/vectors/envelope.json)，
每条带 `direction`，取值 `server->client`、`client->server` 或 `both`。
两端都实现全部消息类型的双向编解码；`direction` 只约束编码侧测试——
在自己不该发的方向发出即判失败，解码侧不按方向筛用例。

| 用例 | 预期结果 |
| --- | --- |
| 未配对时发 `session.request` | `error`，code=`not_authenticated` |
| 配对时口令错误 | `pair.reject`，reason=`bad_password`，计入失败次数 |
| 配对两端短校验码不一致 | 不落盘信任，`pair.reject`，reason=`code_mismatch` |
| 有效 challenge → request → accept | 建立会话，`accept` 带回新 UUID |
| `v` 为 2 | `unsupported_version` 后关闭连接 |
| 未收到质询就发 `session.request` | `not_authenticated` |
| `challenge_id` 过期或已使用 | `session.reject`，reason=`expired` |
| 签名正确但请求 `clipboard` | `session.reject`，reason=`unsupported_permission` |
| `media.answer` 的 `accept` 为 false | 会话结束，`bye.reason=error` |
| 会话结束后再发 `media.answer` | 静默丢弃，不恢复旧会话 |
| `negotiation` 低于当前代次 | 静默丢弃 |
| 同一方向重复 `seq` | 静默丢弃 |
| 未 `input.ready` 就发输入 | `permission_denied` |
| 控制消息超过 64 KiB | `malformed_envelope` 后关闭连接 |

## 8. 传输层要点

### 8.1 二进制消息头（草案）

控制消息之外的所有数据（视频帧分片、输入事件、可靠流分片）共用同一个定长消息头。
以下结构是**草案**，尚未实现；定稿前不得据此编写代码。

| 偏移 | 长度 | 字段 | 说明 |
| --- | --- | --- | --- |
| 0 | 1 | `version` | 传输层版本，v1 为 1 |
| 1 | 1 | `channel` | 通道号，见 [architecture.md](architecture.md) 6.3 |
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

- 传输握手在 TCP 之上先完成一次临时密钥交换，派生会话密钥；`pair.*` 与 `session.*` 消息
  可在握手前的明文通道内收发，媒体与输入只能在加密通道内。
- 通道编号与用途见 [architecture.md](architecture.md) 6.3；控制消息走 `control` 通道，
  分片后同样受每端输入队列与发送队列上限约束。
- 保活由 `ping`/`pong` 在应用层完成，传输层心跳只用于探测链路活性，不参与会话状态判定。

## 9. 待定

- 权限位与后续能力如何扩展，是否需要版本化能力表。
- 加密库选型与握手消息的具体形状（受 AGENTS.md §3 依赖审批约束）。
- 没有摄像头、无法扫描或比对短校验码时的配对回退（真要远程配对再设计 PAKE，例如 SPAKE2）。
- 私钥轮换与“换机但沿用同一 `device_id`”的处理，v1 一律按新设备重新配对。
- Android 控制端的消息编解码实现方式（与 architecture.md 第 10 节的平台待决项一并处理）。
