# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Codeg（Code Generation）是一个多智能体编码工作台，它将多个智能体（Claude Code、Codex CLI、OpenCode、Gemini CLI、OpenClaw、Cline 等）统一到一个工作区中，支持会话聚合和多智能体协作，支持桌面安装，服务器/Docker 部署。

## 技术栈

- **桌面运行时**: Tauri 2（Rust 后端 + webview 前端）
- **服务器运行时**: 独立 Rust 二进制（Axum HTTP + WebSocket）
- **前端**: Next.js 16（静态导出模式）+ React 19 + TypeScript（strict）
- **样式**: Tailwind CSS v4 + shadcn/ui（radix-maia 风格）
- **国际化**: next-intl
- **数据库**: SeaORM + SQLite
- **包管理器**: pnpm

## 代码检查与测试（任务完成后进行必要的检查）

### 前端

```bash
pnpm lint .                    # lint
pnpm test                      # vitest 全跑（CI 用同一条命令）
pnpm test:watch                # 开发时增量重跑
pnpm test:coverage             # 覆盖率报告（输出到 coverage/index.html）
pnpm build                     # 静态导出构建
```

### 后端 Rust（在 `src-tauri/` 目录下执行）

```bash
# 桌面模式（默认 feature）
cargo check
cargo test --features test-utils
cargo clippy --all-targets --features test-utils -- -D warnings

# 服务器模式
cargo check --no-default-features --bin codeg-server
cargo test --no-default-features --bin codeg-server --lib
cargo clippy --no-default-features --bin codeg-server --lib -- -D warnings

# codeg-mcp 协作伴生进程（多智能体委托）
cargo check --no-default-features --bin codeg-mcp
cargo clippy --no-default-features --bin codeg-mcp -- -D warnings

# 解析器快照评审（输出变化时）
cargo insta review
INSTA_UPDATE=auto cargo test --features test-utils     # 自动写新 .snap
```

## 架构

### 双模式运行

项目通过 Cargo feature flags 支持三种二进制：

- **`codeg`**（`tauri-runtime`，默认）：完整桌面应用，包含 Tauri 窗口管理、系统通知、自动更新等
- **`codeg-server`**（无 feature，`--no-default-features`）：独立服务器模式，仅编译 Axum HTTP API + WebSocket
- **`codeg-mcp`**（无 feature）：per-launch stdio MCP 伴生进程，被注入到代理 CLI 的 MCP 配置中，向 LLM 暴露**异步**子智能体委托工具。

### 共享核心

- **`app_state.rs`** — `AppState` 共享状态结构，两种模式通过 `EventEmitter` 枚举区分事件发射方式
- **`web/event_bridge.rs`** — `EventEmitter::Tauri(AppHandle)` 或 `EventEmitter::WebOnly(Arc<WebEventBroadcaster>)`
- **`web/router.rs`** — Axum 路由，接受 `Arc<AppState>`
- **`web/handlers/`** — HTTP API 端点，全部使用 `Extension<Arc<AppState>>`

### Rust 后端（`src-tauri/src/`）

后端负责读取和解析本地文件系统上的代理会话文件：

- **`app_state.rs`** — 共享状态（db、连接管理器、终端管理器、事件广播器）
- **`models/`** — 共享数据结构
- **`parsers/`** — 每个智能体一个解析器
- **`commands/`** — 业务逻辑，`_core` 函数供两种模式共用，`#[tauri::command]` 函数仅桌面模式
- **`web/`** — Axum HTTP API + WebSocket + 静态文件服务 + 认证中间件
- **`acp/`** — Agent Client Protocol 连接管理
- **`db/`** — SeaORM + SQLite

### 前端（`src/`）

#### 核心库（`lib/`）

- **`transport/`** — Transport 抽象层（自动检测 Tauri/Web 环境切换 `invoke()`/`fetch()`）
- **`adapters/`** — AI 响应到组件渲染的适配器
- **`types.ts`** — Rust 模型的 TypeScript 镜像
- **`api.ts`** — 主 API 客户端
- **`tauri.ts`** — Tauri API 封装

#### 国际化（`i18n/`）

- 支持 10 种语言：英语、简体中文、繁体中文、日语、韩语、西班牙语、德语、法语、葡萄牙语、阿拉伯语
- 使用 next-intl 框架，消息文件存放在 `i18n/messages/`

### 数据流

桌面模式：前端 `invoke()` → Tauri 命令 → 业务逻辑 → 返回数据
服务器模式：前端 `fetch()` → Axum HTTP API → 同一业务逻辑 → 返回 JSON
实时通信：后端事件 → EventEmitter（Tauri 事件 / WebSocket 广播）→ 前端

### 条件编译约定

- `#[cfg(feature = "tauri-runtime")]` — 仅桌面模式编译（Tauri 窗口、通知、`tauri::State` 参数等）
- `#[cfg_attr(feature = "tauri-runtime", tauri::command)]` — 函数始终可用，仅在桌面模式标记为 Tauri 命令
- `_core` 后缀函数 — 接受普通引用参数（`&AppDatabase`、`&EventEmitter`），供 Web handlers 和 Tauri 命令共用

## 关键约束

- **仅支持静态导出**：`next.config.ts` 设置 `output: "export"`，不支持动态路由（`[param]`），必须使用查询参数替代
- **路径别名**：`@/*` 映射到 `./src/*`，导入写法为 `@/lib/utils`、`@/components/ui/button`
- **服务器部署**：通过环境变量配置（`CODEG_PORT`、`CODEG_HOST`、`CODEG_TOKEN`、`CODEG_DATA_DIR`、`CODEG_STATIC_DIR`）
- **Docker 支持**：多阶段构建（Node.js + Rust），支持 `docker-compose` 一键部署

## 代码风格

- Prettier：无分号、尾逗号（es5）、2 空格缩进、80 字符宽度
- ESLint：next/core-web-vitals + typescript + prettier
- TypeScript：strict 模式，启用 `noUnusedLocals` 和 `noUnusedParameters`
- Rust：2021 edition，使用 `thiserror` 定义错误类型
