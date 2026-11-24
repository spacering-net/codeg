# 修复方案：任务 diff 统计过期（#1166）与合并提示词矛盾（#1168）

> 状态：方案已评审（Codex 两轮，第二轮通过）；自动合并按推荐处理（与「跟进」一致），已按本方案实现。
> 范围：#1166、#1168。#1167 判定不成立，不在本方案内（见文末附录）。
> 行号以 `bd88b9dac`（v0.45.0）为准。

## 1. 结论与根因

### #1166 成立：「完成任务」对话框说没改文件，分支上却有提交

报告的现象属实，但报告里「确认后会丢失工作」的判断不成立。

- 看板选「合并」还是「完成」，依据的是行上记录的 `files_changed`。
  `src/components/tasks/task-acceptance.ts` 的 `hasNothingToMerge` 判断
  `files_changed === 0`，卡片（`task-actions.ts:218`）和抽屉
  （`task-detail-sheet.tsx:547`）都用它。对话框文案是固定的
  （`task-complete-dialog.tsx:93-96`）。
- `files_changed` 是快照，只在两处写入：
  - 引擎一轮结束时：`src-tauri/src/work_task/engine.rs:3534`，
    `finish_generation` 里的 `snapshot_diff_stats`；
  - 启动时：`engine.rs:538` → `refresh_review_diff_stats`（3886）。
- 从左侧会话列表回复任务会话时，这一轮跑在引擎已经不再索引的连接上：
  `on_turn_complete` 在 `engine.rs:3183-3187` 以「not a task run」直接返回，
  没有任何地方重新测量。
- 抽屉里的「变更文件」列表是实时 git 结果
  （`src-tauri/src/commands/work_task.rs:859`），所以卡片、对话框和抽屉说法不一。
- 工作不会丢：`complete_task`（`engine.rs:3971` 起）在文件夹锁内用
  `has_landable_changes`（4143）重查 git，发现有改动就拒绝，报
  「this task changed files after all — merge it instead of completing it」
  （3995）。
- 真正的问题是拒绝后不回写统计：卡片仍只给「完成」、没有「合并」，形成死路，
  要等下一轮或重启应用才恢复。
- 同类过期还有：在终端里手动提交，或在该工作树里另开会话改文件。

### #1168 成立：内置合并提示词与「合并后删除工作树」选项矛盾

- 合并提示词（`engine.rs:7887-7905`，`compose_prompt` 的 `LaunchMode::Merge`
  分支）固定写着「Do NOT push, do NOT delete this worktree or its branch…」，
  从不说明合并之后会怎样。
- `delete_worktree` 在派发时就已知（`merge_task_inner`，`engine.rs:4330` 写入
  `WorkTaskMergeState`），但 `LaunchMode::Merge`（660-672）没有携带它。
- 合并落地后，settle 会直接删掉工作树和分支（`engine.rs:4503`
  `remove_worktree_locked`）。agent 据提示词推断「工作树和分支保留」，于是总结与实际不符。
- 「不要删除」这条规则必须保留：清理由 codeg 负责，并以 git 实况结算。
  报告建议的「删掉这句话」等于允许 agent 删掉自己所在的工作树。

## 2. 改动方案

一共五部分。Part 0 是 Part 1、Part 2 的前置条件，必须一起落地。

### Part 0：刷新统计时让旧的 preflight 结果失效（前置）

问题（评审第一轮发现）：现有 `refresh_diff_stats`
（`src-tauri/src/db/service/work_task_service.rs:2044`）只改计数、保留
`preflight`。空改动时跑出的绿灯一旦留在有新内容的行上，周期性的 merge pump
（`auto_merge_candidate`，`engine.rs:7161`/7205）就可能把未经测试的新内容自动合并。
另外，`set_preflight`（`work_task_service.rs:2900`）只校验 status + run_seq，
而会话外的回合不推进 run_seq，所以并发的两次 preflight 可能互相覆盖。

1. **计数与失效原子写入。**
   在 `work_task_service.rs` 新增
   `refresh_review_content(conn, id, run_seq, stats, invalidate_preflight: bool) -> Result<bool>`
   （或给 `refresh_diff_stats` 加参数）：
   - CAS 条件与现有一致：`status = review`、`run_seq` 相等、未删除；
   - `invalidate_preflight` 为真时，在同一条 UPDATE 里置 `Preflight = NULL`；
   - 返回是否写入。
2. **preflight 结果绑定到它自己那次运行。**
   - `WorkTaskPreflight`（`src-tauri/src/models/work_task.rs:544`）新增可选字段
     `run_id: Option<String>`（`#[serde(default, skip_serializing_if = "Option::is_none")]`）。
     列本身就是 JSON，不需要迁移；TS 镜像（`src/lib/types.ts` 的 `WorkTaskPreflight`）
     可加可不加，前端不读这个字段。
   - `run_preflight`（`engine.rs:3777-3860`）写 `running` 灯时生成唯一 `run_id`
     （uuid），并保存写进去的 JSON 串。
   - 新增 `finish_preflight(conn, id, run_seq, expect_running_json, light)`：
     在 `set_preflight` 的条件之上，再加 `Preflight == expect_running_json`。
     `run_preflight` 写终态时改用它。
   - 效果：灯一旦被刷新清空，或被更新的一次运行替换，旧运行的终态写入就是空操作，
     不会恢复过期的 passed，也不会记 `preflight_result` 事件。
   - `set_preflight` 继续用于写 `running`，现有测试（`work_task_service.rs:5343-5366`）不受影响。
3. **自动派发在文件夹锁内重新确认资格。**
   - `merge_task_inner`（`engine.rs:4200`）拿到文件夹锁（4250-4251）后，
     若 `auto`，重新读取行，再跑一遍 `auto_merge_candidate`。
   - 不满足就拒绝，报错文案要能被 `is_benign_merge_race`（7256）识别为良性竞争，
     例如带「not in review」或新增一个关键词，让 sweep 静默跳过、不在卡片上挂错误。
   - Part 1、Part 2 都在同一把文件夹锁内写「新计数 + 清灯」，所以自动派发不可能
     用一盏刚被作废的灯完成 CAS。
4. **作废后要重跑。**
   凡是写入时清了灯、且该文件夹配置了 preflight 的路径（包括启动时的 boot 刷新），
   都要随后调用 `spawn_post_review(task.id, task.run_seq)`（`engine.rs:3767`）：
   先重跑 preflight，再给 merge pump 机会。否则这个任务会一直没有灯，永远等不到自动合并。

### Part 1：会话外的回合结束后重新测量（#1166 根因）

全部改动在 `src-tauri/src/work_task/engine.rs`：

1. **抽出公共的刷新函数。**
   把 `refresh_review_diff_stats`（3886-3935）的单行逻辑抽成两个函数：
   - `refresh_review_task_locked(&self, task_id, invalidate_preflight) -> RefreshOutcome`：
     调用方已持有文件夹锁。重读行（必须是 review）→ `live_worktree` →
     `own_work_anchor` → `diff_stats_from` → `refresh_review_content`（Part 0.1）→
     `emit_upsert`。只有 CAS 成功才算写入。返回「是否写入、计数是否变化」。
   - `refresh_review_task(&self, task_id, invalidate_preflight)`：先拿文件夹锁，
     再调 `_locked` 版。文件夹锁是不可重入的 tokio `Mutex`，所以必须拆成两个。
   - boot 刷新改走这个函数：计数变了才作废并重跑，计数没变则行为不变。
2. **在 `on_turn_complete` 的 `entry == None` 分支接入。**
   这条分支只有不属于任何任务回合的连接才会进来。任务回合、held 连接、压缩回合都走原路径；
   压缩回合在更早的 `engine.rs:2867` 就被过滤掉了。
   - 读取该连接的会话状态：`self.manager.get_state(conn_id)` → `conversation_id`、
     `folder_id`（`src-tauri/src/acp/session_state.rs:259`/273）。状态缺失、或两个都是
     `None`，就什么也不做。
   - 用 `tokio::spawn` 调 `refresh_after_foreign_turn(conversation_id, folder_id)`，
     不让 git 阻塞事件循环。测试直接调这个函数，不经过 spawn。
   - 在 `work_task_service.rs` 新增 `list_review_tasks_for_session(conn, conversation_id, folder_id)`，
     查出 `status = review`、未删除、且
     `conversation_id = ? OR worktree_folder_id = ?` 的任务，按 id 去重。
3. **会话外回合一律作废并重跑 preflight。**
   - 配置了 preflight 时，即使总数没变也要这样做，因为一个回合可能改了内容而增删行数恰好相同：
     以 `invalidate_preflight = true` 写入，然后 `spawn_post_review`。
     这与「跟进」一轮 settle 后的行为一致。
   - 没配 preflight 时只写计数；计数变化了才 `spawn_merge_pump(folder_id)`。

效果：从会话列表回复、让 agent 提交以后，这一轮一结束，卡片和抽屉就切到「合并」，
并显示「N 个文件 +a/-b」。

### Part 2：「完成」被拒时自愈（覆盖 Part 1 看不到的改动）

在 `complete_task`（`engine.rs:3995`，此时已持有文件夹锁）里，当
`has_landable_changes` 为真时，返回错误之前：

- 调 `refresh_review_task_locked(task_id, true)`，写入新计数并清灯，再 `emit_upsert`；
- 配置了 preflight 时调 `spawn_post_review`。

状态保持 review；工作树和分支不动，因为拒绝发生在任何删除之前。错误文案不变。
这样终端里手动提交之类的情况，第一次点「完成」就会自动纠正卡片。

### Part 3：实时行已有改动时，对话框自动关闭

- `TaskCompleteDialog` 的 `task` 继续传打开时捕获的 `completeTask`。原因（评审第一轮发现）：
  它的 `[open, task]` effect（`task-complete-dialog.tsx:51`）负责初始化
  `deleteWorktree` 和 `submitting`；而 provider 每次刷新都会给出新对象
  （`src/contexts/tasks-view-context.tsx:92`）。如果传实时行，任何任务一变，
  用户取消勾选的「删除工作树」就会被重新勾上，提交中的按钮也会被重新启用。
- 在 `use-task-dialogs.tsx` 仿照 `mergeLiveTask`（114）算出实时行：
  `tasks.find(t => t.id === completeTask?.id)`。再传一个新 prop
  `stillNothingToMerge = live == null || hasNothingToMerge(live)`。
- 对话框里加一个 effect：`open && !stillNothingToMerge` 时调 `onOpenChange(false)`。
  Part 2 的错误 toast 已经说明了原因，卡片此时也已经显示「合并」。
- 工作树已不在的任务仍可完成，因为 `hasNothingToMerge` 本身就包含 `isWorktreeGone`。
- 不新增 i18n 文案。

### Part 4：合并提示词写明清理选择（#1168）

- `LaunchMode::Merge`（`engine.rs:660`）新增 `delete_worktree: bool`，在
  `merge_task_inner` 构造处（4380）用入参 `delete_worktree` 填充。
  点击、排队（pump 用排队时记录的 `intent.delete_worktree`）、自动合并
  （`settings.delete_worktree_default`）三条路径都经过这里。
- 「Do NOT push, do NOT delete…」这条规则保留，在它后面追加一句：
  - 选了删除：`After it has verified the landing, Codeg will remove this worktree
    and the `{work_branch}` branch itself, as the user chose — leave that to it,
    and do not describe them as kept.`
  - 没选删除：`The worktree and the `{work_branch}` branch stay after the merge,
    as the user chose.`
  - 措辞只描述「计划中的清理」，不承诺脏工作树保护：合并 settle 直接调
    `remove_worktree_locked`（4503），不走「完成」和「交付」路径上的未提交检查；
    清理失败会在卡片上显示，并可以重试。
- 这些规则仍是最后一段内置文本，现有测试
  `merge_prompt_carries_the_users_instructions_ahead_of_the_rules`（10526）继续成立。
- 同步更新测试辅助 `merge_mode()`（9350），以及解构它的测试（10528-10546）。

## 3. 涉及文件

| 文件 | 改动 | 对应 |
| --- | --- | --- |
| `src-tauri/src/db/service/work_task_service.rs` | `refresh_review_content`、`finish_preflight`、`list_review_tasks_for_session` + 测试 | Part 0/1 |
| `src-tauri/src/models/work_task.rs` | `WorkTaskPreflight.run_id` | Part 0 |
| `src-tauri/src/work_task/engine.rs` | preflight 绑定、自动派发复核、刷新函数拆分、`on_turn_complete` 接入、`complete_task` 自愈、`LaunchMode::Merge.delete_worktree` 与提示词 + 测试 | Part 0–2、4 |
| `src/components/tasks/use-task-dialogs.tsx` | 实时行 → `stillNothingToMerge` | Part 3 |
| `src/components/tasks/task-complete-dialog.tsx` | 新 prop + 自动关闭 effect | Part 3 |
| `src/components/tasks/task-complete-dialog.test.tsx` 等 | 前端测试 | Part 3 |

## 4. 风险与待定

- **自动合并（已定：按推荐）。** 文件夹开了自动合并时，一个在 review 里的任务因为会话列表
  回复而有了改动，preflight 重跑通过后就会被自动合并——和「跟进」一轮 settle 后的行为一致。
- **未覆盖的改动来源。** Part 1 只覆盖「有 agent 回合结束」的改动。在终端或编辑器里直接改，
  仍靠 Part 2（第一次点「完成」时纠正）和启动时的刷新。
- **额外开销。** 每个非任务连接的 TurnComplete 多一次按会话/文件夹的 DB 查询，开销小，
  且在 spawn 里执行。配置了 preflight 时，在 review 任务的会话里聊天，每一轮都会重跑一次 preflight。
- **新一轮不会被旧计数覆盖。** `refresh_review_content` 绑定 run_seq：
  测量期间如果任务被认领进入新一轮，这次写入就是空操作，也不会触发 post-review。
- **不在范围内。** 把会话列表里的回复当成真正的任务回合（状态 → running）是报告者提的另一种做法，
  改动面大，本方案不做。

## 5. 验证

Rust 测试使用 `engine.rs` 里现有的真实 git 夹具（参考 14022、14165 附近的刷新测试）。
会话状态用 `manager.insert_test_connection`（`src-tauri/src/acp/manager.rs:787`）构造，
再写入 `conversation_id`/`folder_id`。

- **会话外回合刷新**
  - review 任务 `files_changed = 0`，在工作树里提交后调 `refresh_after_foreign_turn`：
    行变成 files>0，并发出 upsert。按 conversation_id 匹配、按 worktree folder_id 匹配各测一次。
  - 无关会话、非 review 任务、已删除任务：行不变。
  - 两个条件命中同一任务时只刷新一次；会话状态缺失或没有 id 时什么都不做。
  - 没配 preflight 且计数没变：不触发 pump。
- **preflight**
  - 两条刷新路径都会把过期的 passed 灯清空，并且重跑。
  - 总数相同但内容变了：仍然重跑。
  - 旧运行在新运行之后、或在作废之后才结束：什么都不写，也不记 `preflight_result`。
  - 刷新期间与自动派发竞争：派发被良性拒绝，不挂错误。
- **一轮被认领的竞态**
  测量途中暂停，认领新一轮后再继续：不写计数、不发 upsert、不触发 post-review。
- **完成被拒自愈**
  `files_changed = 0` 的任务有新提交时，`complete_task` 返回 Err，行变成 files>0，
  状态仍是 review，工作树和分支都在。现有的未跟踪文件、PR anchor 测试继续通过。
- **合并提示词**
  `delete_worktree = true/false` 分别出现对应的句子，规则仍在用户指令之后。
  点击、排队、自动三条派发路径都能把清理选择带进提示词。
- **前端（vitest）**
  - 实时行变成 files>0 时对话框关闭。
  - 无关刷新后，取消勾选的「删除工作树」保持不勾选，提交中保持禁用。
  - 包含 `useTaskDialogs` 的接线测试。
- **全量门禁（按 CLAUDE.md）**
  - `pnpm lint .`、`pnpm test`；
  - `src-tauri/` 下桌面、server、mcp 三套的 `cargo check`、`cargo test`、`cargo clippy -D warnings`；
  - 桌面全量 `cargo test` 单独跑。

## 6. 建议的提交拆分

1. `fix(work-task): tie preflight results to their run and recheck auto-merge under the folder lock`（Part 0）
2. `fix(work-task): re-measure review tasks after turns outside a task round`（Part 1 + Part 2）
3. `fix(tasks): close the complete dialog once the task has changes to merge`（Part 3）
4. `fix(work-task): tell the merge agent whether codeg removes the worktree afterwards`（Part 4）

## 附录：#1167 为何不纳入

- **报告：** Windows 上用 `D:\…` 调 MCP `create_work_task`，工具报成功，但任务分到了别的项目。
- **为什么不是盘符大小写：**
  - `resolve_folder` → `match_folder_by_path`（`src-tauri/src/commands/chat_authoring.rs:144-157`）
    用的是 `Path::starts_with`。
  - Rust 标准库在 Windows 上解析前缀时会把盘符转成大写（`std/src/sys/path/windows_prefix.rs`
    的 `parse_drive`），`PrefixComponent` 也按解析后的值比较（`std/src/path.rs`）。
  - 所以 `D:\Projects\MyApp` 与 `d:\Projects\MyApp` 能匹配上。真匹配不上的话，
    工具会返回「no project matching … is known to codeg」，而不是报成功。
- **「成功但项目不对」需要另一条记录：**
  - 必须存在第二条未删除、且匹配同一路径的文件夹记录，比如以 `D:\Projects\MyApp` 存下的已关闭记录。
  - 文件夹记录按完整路径字符串区分（`src-tauri/src/db/service/folder_service.rs:138`）。
  - 同深度命中时 `max_by_key` 取最后一个，不会优先选打开的项目。
- **重开所需信息：**
  - 那次调用返回的 `folder_name`/`folder_path`；
  - 任务实际落到的项目；
  - 文件夹历史里是否还有第二个 `MyApp`。
- **另一个弱点（报告未涉及）：** 目录名大小写不同（如 `D:\projects\myapp`）在 Windows 上会被拒绝。
  要不要一并处理，由用户决定。
