# Antigravity ACP 后台等待阻塞收尾：PR #1128 调查记录

## 结论与原改动处理

已在 Antigravity ACP 1.4.5（Windows x86_64）复现明确的阻塞链：后台命令仍运行时，主轨迹进入 STATE_WAITING_FOR_TASKS；SDK 没有据此结束前台步骤流，ACP 的 session/prompt 响应继续等待完全空闲。持续运行的开发服务器可长期阻止回合收尾。

接受[维护者对原 PR 的分析](https://github.com/spacering-net/codeg/pull/1128#issuecomment-6800074471)：单连接 fs 回调串行执行，生产调用链达不到测试手工耗尽 8 个许可的前提。因此已完整撤销原提交的 OwnedSemaphorePermit 导入、15 秒许可超时、辅助方法、读写入口替换及两个手工耗尽许可的测试。file_system_runtime.rs 与该 PR 原始基线完全一致。

当前 PR 只提交调查文档及脱敏证据。修复验证发生在本机外部 Antigravity SDK/ACP 适配器；本 PR 没有把运行时热补丁安装逻辑加入 Codeg，也不应作为 Codeg 产品修复直接发布。

## 环境与证据层次

| 项目 | 实际范围 |
| --- | --- |
| 宿主 | Codeg 0.42.3 Windows 桌面版 |
| 外部运行时 | Antigravity ACP 1.4.5，Windows x86_64 |
| 协议探针 | 独立 ACP 客户端，真实模型与后台命令 |
| 模型配置 | 返回配置为 gemini-3.8-flash；后台探针设为 low thinking |
| 原始服务器 SHA-256 | ccca30a4aef1b915b0d8baa17b149de6cda305841fa27717e52c529bb462c51d |
| 最终热修复 SHA-256 | 8d5e5cd2c540c8c4c4ed55581ab958c5ccfcc1ecde54df686cf37625152808fc |

必须区分两条通道：

- direction=harness 是探针对内部 harness 输出事件的观测，包含 trajectoryStateUpdate；STATE_WAITING_FOR_TASKS 不是标准 ACP 的停止原因。
- client_to_agent、agent_to_client 是 ACP JSON-RPC 元数据。回合是否结束，以对应请求 ID 的 session/prompt 响应及 stopReason 为准。

证据文件保留相对毫秒、RPC ID、方法、状态、步骤索引和配置；不包含提示词、文件正文、账号配置或 stderr 原始片段。会话、轨迹和工具 ID 已做稳定别名替换，harness 的 JSON 字符串展开为对象；这是脱敏转换后的记录。源文件与发布文件哈希见 [manifest.json](evidence/manifest.json)。

## 原行为：后台等待不返回前台响应

[baseline-background.jsonl](evidence/baseline-background.jsonl) 的关键时间点：

| 自探针启动累计时间 | 观测 |
| --- | --- |
| 15.562 秒 | 发送 session/prompt，请求 ID 3 |
| 87.125 秒 | 工具状态进入 in_progress |
| 230.000 秒 | 主轨迹进入 STATE_WAITING_FOR_TASKS |
| 315.562 秒 | 请求等待 300 秒到期，仍未收到自然结束响应 |
| 315.562 秒 | 探针发送 session/cancel |
| 315.594 秒 | 主轨迹变为 STATE_FULLY_IDLE，请求 3 才返回 stopReason=cancelled |

这个用例使用后台 python -c "import time; time.sleep(600)"。300 秒从发送 prompt 开始计算；进入 WAITING 后实际观察约 85.6 秒，不能写成“WAITING 已持续 300 秒”。取消后的响应也不能当作正常完成。

这轮元数据中没有 fs/read_text_file 或 fs/write_text_file 请求。结合 SDK 回归，阻塞可以在没有 Codeg fs 回调参与的情况下出现。

## SDK 层机制

核对实际包中以下模块：

- google.antigravity.connections.local.event_processor
- google.antigravity.connections.local.local_connection
- google3.cloud.developer_experience.antigravity_extensions.acp_server.server

主轨迹 STATE_FULLY_IDLE 分支设置 is_idle 并入队 IDLE_SENTINEL，使等待中的 receive_steps() 退出；原状态处理没有为 STATE_WAITING_FOR_TASKS 提供对应的前台结束行为。ACP 适配器等待步骤流结束后才返回 PromptResponse，于是把前台回合完成与全部后台工作完成绑在一起。

在原运行时注入只调用真实 SDK 的回归入口，发送主轨迹 WAITING 事件后，步骤流无法在测试期限内结束，得到 AssertionError: waiting_for_tasks_does_not_finish_foreground_turn。见 [sdk-baseline-result.json](evidence/sdk-baseline-result.json)。此期限用于验证显式状态转换后的迭代器唤醒，不是按耗时强制终止模型。

## 修复方案及兼容边界

修复位置应在外部 SDK/ACP 适配层。已验证的本地方案：

1. **按会话启用前台语义。** 只对归属明确的普通会话启用；只读会话元数据 parent_id、delegation_call_id。委托、归属不明、记录缺失、数据库不可读时继续等待完全空闲。
2. **处理主轨迹 WAITING。** 记录主轨迹状态，在启用前台语义时设置 idle 并入队 sentinel，唤醒已经阻塞的步骤迭代器；不取消后台任务。子轨迹 WAITING 不结束主回合，RUNNING 清除旧 idle。
3. **继续消费后台步骤。** 前台返回后启动后台消费者，继续通过 ACP 转发步骤和文本；不能简单停止读取。
4. **保活与结算。** 发布 Codeg AIR 扩展 async_task_spawned，使用 taskType=monitor、canStop=false；后台存活期间每 30 秒发布 async_task_progress，完全空闲后发布 async_task_state_update 并结算工具卡片。这些是 Codeg 扩展，不能假定所有 ACP 客户端都支持。
5. **无损交接下一轮。** 停止后台消费者前排空已入队步骤；前台 reset 保留待处理队列；SDK agent.chat() 隐式排出的历史步骤也必须转发，临时包装在 finally 恢复。后台读卡片跨交接保留并在完全空闲时结算；后台转发失败不能永久阻塞下一轮。
6. **保持委托完成语义。** Codeg 委托 broker 将 TurnComplete 用作子任务完成信号。不能把所有 B 子会话的 WAITING 统一提前结束，否则会让父代理过早收取结果并断开仍在工作的子会话。未来若要让委托也提前结束前台，须先调整任务生命周期契约。

本地补丁按连接维护开关；探针仅在自身进程中明确指定普通会话模式，没有给全局用户设置强制普通会话。读取 Codeg SQLite 归属是本机兼容措施；正式方案宜让宿主明确传递会话角色和后台能力，并由外部 SDK 原生区分“前台结束”与“完全空闲”。

不建议根据最终文本或固定秒数猜测完成，也没有依据为本问题改造 Codeg fs 分发并发性。

## 修复后的真实协议验证

[fixed-background.jsonl](evidence/fixed-background.jsonl) 使用后台 python -c "import time; time.sleep(240)"，提示模型短暂等待启动后立即回复。基线后台时长是 600 秒、修复后是 240 秒，因此这里验证状态与生命周期，不做耗时加速比对。

| 自探针启动累计时间 | 观测 |
| --- | --- |
| 8.125 秒 | 请求 3 发起 session/prompt |
| 16.031 秒 | 主轨迹 WAITING，同毫秒收到 async_task_spawned 和请求 3 的 stopReason=end_turn |
| 46.047—226.094 秒 | 7 次 async_task_progress |
| 255.515 秒 | 后台工具完成并通过 ACP 更新为 completed |
| 258.937 秒 | 主轨迹完全空闲，收到后台状态更新 |
| 258.937 秒 | 发起同会话下一次 session/prompt，请求 ID 7 |
| 267.094 秒 | 请求 7 返回 stopReason=end_turn |

16.031 秒从探针启动累计计算；从第一次 prompt 发出算，响应等待约 7.906 秒。下一轮在后台结算后发送；与后台步骤同时交接的场景由 SDK 回归覆盖。

元数据日志保留了后台状态更新的种类；其 state=completed 由探针内存中的检查及 stdout 确认，记录在 [live-result.json](evidence/live-result.json)，不能单从通知种类推断状态值。

## 回归与反证

- 原 SDK 回归失败；最终构建包真实 SDK 16 项回归通过，实际安装入口再跑 16 项也通过，退出码均为 0、stderr 为空。见 [sdk-fixed-result.json](evidence/sdk-fixed-result.json) 与 [installed-result.json](evidence/installed-result.json)。
- 覆盖 WAITING 唤醒、后台继续运行、子轨迹隔离、RUNNING 重置、关闭开关、完全空闲、委托与数据库异常保守处理、后台 FIFO、保活、队列交接、工具卡片结算，以及 SDK 发新提示前的隐式历史排空。
- 开发中实际捕获并修复过交接丢步骤和后台读卡片不结算；最终测试包含这两类回归。
- [read-control.jsonl](evidence/read-control.jsonl) 中，文件 RPC 的本地处理很快，整个请求却在约 297 秒才正常 end_turn。长观察窗口揭示正常的后续模型等待，因此“超过 150 秒”或“文本已出现”都不足以判死锁。
- Antigravity B 独立审查最终方案通过；安装后通过 Codeg 新启动的 B 委托会话完成入口核验。该核验确认新入口可用，并不等于已完成普通聊天 UI 后台卡片的人工端到端验收。

## 复现与后续落地

可用独立 ACP 客户端复现，无需先改 Codeg：

1. 启动原 Antigravity ACP 1.4.5，完成 initialize、session/new，显式记录协商的模型配置。
2. 发送提示，要求启动上述后台 sleep 命令，短暂等待启动后回复 READY；处理这次探针命令的权限请求。
3. 同时采集 ACP 方法、请求 ID、返回停止原因，以及内部 harness 主轨迹状态；前台文本不作为完成判据。
4. 对原包记录 WAITING 后 prompt 是否仍挂起；到观察期限主动取消时，单独标记取消及其响应。
5. 对支持前台语义的修复适配器，验证 WAITING 后返回 end_turn、后台继续产出与保活、完全空闲结算，以及同会话后续提示成功；额外检查委托会话不提前完成。

当前热修复已在本机通过同卷目录切换安装，保留原目录且不终止已有进程；没有上传修改后的外部二进制或替换 Codeg 下载源。PR 保留草稿用于证据与方案审查；正式发布应在外部适配器层落实前台/后台语义，并与 Codeg 会话角色、AIR 能力协商共同验收。

历史卡住会话缺少原始 JSON-RPC，不能把本次机制追溯为所有历史停顿的原因。本记录确认的是上述版本中已复现并用运行时回归和真实协议验证的后台等待阻塞。
