# 父子会话多轮沟通

父会话先用 `delegate_to_agent` 创建子会话，再用返回的
`child_conversation_id` 向同一个子会话继续发送消息。每次发送都有独立的
`message_id`，子会话的 ID、工作目录和代理上下文保持不变。

## 发送和管理

排队发送是默认行为，当前轮结束后按顺序执行：

```json
{"child_conversation_id": 42, "message": "完成后补充接口测试", "delivery": "queue"}
```

以上参数传给 `send_to_subsession`。需要马上调整时，使用
`"delivery": "immediate"`：支持原生 steering 的连接直接接收指令；否则取消
当前轮，等待原 ACP 请求、旧通知和生命周期持久化处理完成，再发送新一轮。
取消确认超过 30 秒会暂停续发并返回错误，不会并发执行两个 prompt，也不会
暗中新建空白会话。

通过 `manage_subsession_messages` 查询消息及结果：

```json
{"child_conversation_id": 42, "action": "list"}
```

修改或取消仍在排队的消息：

```json
{"child_conversation_id": 42, "action": "update", "message_id": "返回的消息 ID", "message": "完成后改为补充异常路径测试"}
{"child_conversation_id": 42, "action": "cancel", "message_id": "返回的消息 ID"}
```

编辑、取消与出队竞争时，以数据库条件更新的结果为准。已经开始投递或执行
的消息返回 `not_queued`，不会被队列编辑接口覆盖。

## 状态和恢复

- `queued`：等待执行，可编辑或取消。
- `dispatching`：立即消息已被认领，正在 steering 或停止原执行轮。
- `running`：消息作为新一轮 prompt 执行。
- `delivered`：指令已通过 steering 投递，不表示代理已完成处理。
- `completed`、`failed`、`canceled`：该轮的结果。
- `interrupted`：认领消息的进程已退出；不会自动重放已执行过的操作。

消息、顺序和结果保存在 SQLite。刷新浏览器不会丢失队列；父会话重新连接后
查询或发送消息，会重新检查待执行队列。代理连接已回收时，必须成功加载原
代理会话才能继续；无法续接时明确拒绝。

原 `task_id` 仍用于首次委托和中断恢复。后续消息通过上述管理工具读取结果，
不使用 `resume_delegation` 携带新指令。子会话完成不会主动启动空闲父会话的
下一轮推理。

## 验证

只使用 `codeg-server` 的 HTTP/WebSocket 服务、MCP 伴生进程及 ACP 协议测试
代理验证。遵守 `AGENTS.md`，禁止编译或使用桌面端作为测试对象。
