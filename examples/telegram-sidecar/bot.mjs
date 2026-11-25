// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  loadConfig,
  loadTelegramToken,
  loadCodegToken,
  resolveTelegramProxy,
} from "./lib/secrets.mjs"
import {
  TelegramClient,
  isConflictError,
  isTopicDisabledError,
  isThreadNotFoundError,
} from "./lib/tg.mjs"
import { CodegClient, isTurnInProgressError } from "./lib/codeg.mjs"
import { StateStore } from "./lib/state.mjs"
import { redactText, redactUrl, registerSecret } from "./lib/redact.mjs"
import { WebAppProxy } from "./lib/webapp-proxy.mjs"
import { QuickTunnelManager } from "./lib/tunnel.mjs"
import {
  escapeHtml,
  truncateText,
  mdToTelegramHtml,
  splitMarkdownForTelegram,
  formatAgentBadge,
  formatPermissionCard,
  formatQuestionCard,
  formatPlanApprovalCard,
  formatStreamingMessage,
  formatSessionList,
} from "./lib/format.mjs"

const BOT_COMMANDS = [
  { command: "new", description: "新建会话" },
  { command: "sessions", description: "切换 / 接管会话" },
  { command: "web", description: "手机端网页 / 安全控制" },
  { command: "mode", description: "切换权限模式" },
  { command: "model", description: "切换模型 / 推理档位" },
  { command: "stop", description: "停止当前输出" },
  { command: "history", description: "查看最近对话" },
  { command: "status", description: "当前会话状态" },
  { command: "rename", description: "重命名会话" },
  { command: "close", description: "关闭当前会话" },
  { command: "help", description: "控制面板与帮助" },
]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wrap a Telegram client so every outbound text is redacted. Bot replies quote
 * upstream error messages, and those can contain a token from another layer.
 */
function wrapTelegramClient(tg) {
  if (!tg) return tg
  const wrapText = (fn, textIndex) => {
    if (typeof tg[fn] !== "function") return undefined
    return (...args) => {
      if (typeof args[textIndex] === "string")
        args[textIndex] = redactText(args[textIndex])
      return tg[fn](...args)
    }
  }
  const wrapped = Object.create(tg)
  const overrides = {
    sendMessage: wrapText("sendMessage", 1),
    editMessageText: wrapText("editMessageText", 2),
    sendDocument: wrapText("sendDocument", 2),
  }
  for (const [name, fn] of Object.entries(overrides)) {
    if (fn) wrapped[name] = fn
  }
  // answerCallbackQuery(id, { text }) — redact the option text.
  if (typeof tg.answerCallbackQuery === "function") {
    wrapped.answerCallbackQuery = (id, opts = {}) => {
      const next = { ...opts }
      if (typeof next.text === "string") next.text = redactText(next.text)
      return tg.answerCallbackQuery(id, next)
    }
  }
  return wrapped
}

export function createLogger(logFile, { quietConsole = false } = {}) {
  const dir = logFile ? path.dirname(logFile) : null
  if (dir) fs.mkdirSync(dir, { recursive: true })

  const write = (level, msg) => {
    // Single redaction boundary for every log sink: registered secrets are masked,
    // credential shapes are masked, and the diagnostic text is kept.
    const line = redactText(`[${new Date().toISOString()}] [${level}] ${msg}`)
    if (!quietConsole) {
      if (level === "ERROR" || level === "WARN") console.error(line)
      else console.log(line)
    }
    if (logFile) {
      try {
        try {
          const stat = fs.statSync(logFile)
          if (stat.size > 5 * 1024 * 1024) {
            const rotated = `${logFile}.1`
            try {
              fs.unlinkSync(rotated)
            } catch {
              // ignore
            }
            fs.renameSync(logFile, rotated)
          }
        } catch {
          // file may not exist yet
        }
        fs.appendFileSync(logFile, `${line}\n`, "utf8")
      } catch {
        // ignore log write failure
      }
    }
  }

  return {
    info: (m) => write("INFO", m),
    warn: (m) => write("WARN", m),
    error: (m) => write("ERROR", m),
  }
}

export class CodegTgBot {
  constructor({
    cfg,
    tg,
    codeg,
    state,
    webappProxy = null,
    tunnel = null,
    logger = console,
  }) {
    this.cfg = cfg
    // Every outbound Telegram text passes the redaction boundary, so an upstream
    // error quoted into a chat cannot carry a token.
    this.tg = wrapTelegramClient(tg)
    this.codeg = codeg
    this.state = state
    this.webappProxy = webappProxy
    this.tunnel = tunnel
    // Every bot log line passes this facade, so an injected logger can never emit a
    // token even if a call site forgets to redact.
    this.logger = {
      info: (m) => logger.info?.(redactText(m)),
      warn: (m) => logger.warn?.(redactText(m)),
      error: (m) => logger.error?.(redactText(m)),
    }

    this.allowedUsers = new Set(
      (cfg.allowedUserIds || []).map((id) => Number(id))
    )
    this.botUsername = ""
    this.miniAppUrl = ""
    this.running = false
    this.syncTimer = null

    // Live per-connection caches & interactive trackers
    this.connModes = new Map() // connectionId -> { current_mode_id, available_modes }
    this.connConfigOptions = new Map() // connectionId -> SessionConfigOptionInfo[]
    this.connMeta = new Map() // connectionId -> { conversationId, folderId, folderName, agentType }
    this.snapshotWaiters = new Map() // connectionId -> Array<resolveFn>

    this.permissionCards = new Map() // `${connectionId}:${requestId}` -> card
    this.questionCards = new Map() // `${connectionId}:${questionId}` -> card
    this.planCards = new Map() // `${connectionId}:${approvalId}` -> card

    // Reply routing keys are scoped to the chat (and thread) the card was sent to,
    // because Telegram message ids are only unique within a chat.
    this.pendingQuestionReplyByMsgId = new Map() // `${chatId}:${threadId}:${messageId}` -> cardKey
    this.pendingPlanFeedbackByMsgId = new Map() // `${chatId}:${threadId}:${messageId}` -> cardKey

    this.turnStreams = new Map() // connectionId -> stream state
    this.typingTimers = new Map() // connectionId -> interval
  }

  // ─── Chat-scope helpers ───────────────────────────────────

  /**
   * Telegram message ids are unique per chat only. Reply routing therefore keys on
   * (chatId, threadId, messageId) so chat B can never consume chat A's pending card.
   */
  _replyKey(chatId, threadId, messageId) {
    const tid = Number.isInteger(threadId) && threadId > 0 ? threadId : 0
    return `${Number(chatId)}:${tid}:${Number(messageId)}`
  }

  /** A card belongs to exactly one chat and one topic; anything else is refused. */
  _ownsCard(card, chatId, threadId) {
    if (!card) return false
    const tid = Number.isInteger(threadId) && threadId > 0 ? threadId : 0
    return (
      Number(card.chatId) === Number(chatId) &&
      Number(card.threadId || 0) === tid
    )
  }

  /**
   * A persisted callback belongs to the chat/topic that created it.
   *
   * Callbacks written by an older version carry no owner. They are honoured only
   * when the owner is unambiguous — a single known chat, which must be this one —
   * so a single-user deployment keeps its existing keyboards working. As soon as a
   * second chat exists they are refused rather than guessed, and the user is told
   * to re-issue the command.
   */
  _ownsCallback(entry, chatId, threadId) {
    if (!entry) return false
    const owner = entry.data?.chatId
    if (owner === undefined || owner === null) {
      // Owner unknown (written by an older version). Safe only while exactly one
      // chat exists and it is this one; the thread cannot be verified, but every
      // topic of a single private chat belongs to the same person.
      const knownChats = this.state.getKnownChatIds()
      if (knownChats.length === 0) return true
      if (knownChats.length > 1) return false
      return Number(knownChats[0]) === Number(chatId)
    }
    if (Number(owner) !== Number(chatId)) return false
    const ownerTid = Number(entry.data?.threadId || 0)
    const tid = Number.isInteger(threadId) && threadId > 0 ? threadId : 0
    return ownerTid === tid
  }

  async start({ skipPoll = false } = {}) {
    this.running = true
    this._wireCodegEvents()

    await this._checkCodegStartup()
    this.codeg.connectWs()

    if (this.webappProxy) {
      try {
        await this.webappProxy.start()
      } catch (err) {
        this.logger.error(`[webapp] proxy failed to start: ${err.message}`)
      }
    }
    if (this.tunnel) {
      this.tunnel.on("url", (url) => {
        this.miniAppUrl = url
        if (this.cfg.miniApp?.autoUpdateMenuButton !== false) {
          this._syncMenuButton(url).catch((err) => {
            this.logger.warn(
              `[miniapp] setChatMenuButton failed: ${err.message}`
            )
          })
        }
      })
      this.tunnel.start()
    }

    const initTelegramMeta = async () => {
      try {
        const me = await this.tg.getMe()
        this.botUsername = me?.username || ""
        if (this.webappProxy && this.botUsername) {
          this.webappProxy.botUsername = this.botUsername
        }
        this.logger.info(
          `[bot] Telegram authorized as @${this.botUsername || me?.id}`
        )
        await this.tg.setMyCommands(BOT_COMMANDS).catch((err) => {
          this.logger.warn(`[bot] setMyCommands failed: ${err.message}`)
        })
        if (
          this.miniAppUrl &&
          this.cfg.miniApp?.autoUpdateMenuButton !== false
        ) {
          await this._syncMenuButton(this.miniAppUrl).catch(() => {})
        }
      } catch (err) {
        this.logger.warn(
          `[bot] Telegram getMe failed at startup: ${err.message}`
        )
      }
    }
    if (skipPoll) {
      await initTelegramMeta()
    } else {
      initTelegramMeta().catch(() => {})
    }

    this.syncTimer = setInterval(() => {
      if (this.running && this.cfg.proactiveWatchDesktop) {
        this._syncLiveConnections().catch(() => {})
      }
    }, 30000)
    this.syncTimer.unref?.()

    if (!skipPoll) {
      this._pollLoop()
    }
  }

  async _syncMenuButton(url) {
    const menuButton = url
      ? { type: "web_app", text: "Codeg 面板", web_app: { url } }
      : { type: "commands" }
    const chatIds = new Set()
    for (const cid of this.state.getKnownChatIds()) chatIds.add(cid)
    const primary = this.state.getPrimaryChatId()
    if (primary) chatIds.add(primary)
    for (const uid of this.allowedUsers) chatIds.add(uid)

    await this.tg.setChatMenuButton({ menuButton }).catch(() => {})
    for (const cid of chatIds) {
      await this.tg
        .setChatMenuButton({ chatId: cid, menuButton })
        .catch(() => {})
    }
    this.logger.info?.(
      `[miniapp] menu button updated (${url ? "web_app" : "commands"})`
    )
  }

  stop() {
    this.running = false
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    for (const timer of this.typingTimers.values()) {
      clearInterval(timer)
    }
    this.typingTimers.clear()
    for (const stream of this.turnStreams.values()) {
      if (stream.timer) clearTimeout(stream.timer)
    }
    this.turnStreams.clear()
    this.tunnel?.stop()
    this.webappProxy?.stop().catch(() => {})
    this.codeg.closeWs()
    try {
      this.state.saveNow()
    } catch {
      // ignore
    }
  }

  async _checkCodegStartup() {
    try {
      const h = await this.codeg.health()
      this.logger.info(
        `[codeg] connected: v${h?.version || "?"} (${this.cfg.codegUrl})`
      )
      const channels = await this.codeg.listChatChannels().catch(() => [])
      const enabledTg = (channels || []).filter(
        (c) => c?.channel_type === "telegram" && c?.enabled
      )
      if (enabledTg.length > 0) {
        this.logger.warn(
          `[codeg] WARNING: Codeg built-in Telegram channel (${enabledTg.map((c) => c.name).join(", ")}) is STILL ENABLED! Disable it in Codeg Settings -> Chat Channels to prevent Telegram 409 Conflict.`
        )
      }
    } catch (err) {
      this.logger.warn(
        `[codeg] Codeg Web Service not reachable at ${this.cfg.codegUrl}: ${err.message}. Will retry via WS reconnect.`
      )
    }
  }

  _wireCodegEvents() {
    this.codeg.on("ws_open", () => {
      if (this.cfg.proactiveWatchDesktop) {
        this._syncLiveConnections().catch((err) => {
          this.logger.warn(`[sync] initial sync failed: ${err.message}`)
        })
      }
    })

    this.codeg.on("global", ({ channel, payload }) => {
      if (!this.running || !this.cfg.proactiveWatchDesktop) return
      if (channel === "conversation://changed") {
        if (payload?.kind === "status" || payload?.kind === "upsert") {
          this._syncLiveConnections().catch(() => {})
        }
      }
    })

    this.codeg.on("snapshot", ({ connectionId, snapshot }) => {
      this._handleSnapshot(connectionId, snapshot).catch((err) => {
        this.logger.error(`[ws] snapshot handler error: ${err.message}`)
      })
    })

    this.codeg.on("acp", ({ connectionId, envelope }) => {
      this._handleAcpEvent(connectionId, envelope).catch((err) => {
        this.logger.error(
          `[ws] acp handler error (${envelope?.type}): ${err.message}`
        )
      })
    })

    this.codeg.on("detached", ({ connectionId, reason }) => {
      if (reason === "connection_gone") {
        this._stopTyping(connectionId)
        this.connModes.delete(connectionId)
        this.connConfigOptions.delete(connectionId)
        const binding = this.state.findThreadByConnectionId(connectionId)
        if (binding) {
          this.state.updateThread(binding.chatId, binding.threadId, {
            connectionId: null,
          })
        }
      }
    })
  }

  async _syncLiveConnections() {
    let conns
    try {
      conns = await this.codeg.acpListConnections()
    } catch {
      return
    }
    if (!Array.isArray(conns)) return

    for (const conn of conns) {
      if (!conn?.id) continue
      if (!this.connMeta.has(conn.id)) {
        this.connMeta.set(conn.id, { agentType: conn.agent_type })
      }
      if (!this.codeg.isAttached(conn.id)) {
        this.codeg.attach(conn.id, null)
      }
    }
  }

  async _pollLoop() {
    let conflictNoticeShown = false
    while (this.running) {
      try {
        const offset = this.state.getUpdateOffset()
        const updates = await this.tg.getUpdates({
          offset: offset > 0 ? offset : undefined,
          timeout: this.cfg.pollTimeoutSec || 25,
        })
        conflictNoticeShown = false
        if (Array.isArray(updates)) {
          for (const update of updates) {
            if (typeof update?.update_id === "number") {
              this.state.setUpdateOffset(update.update_id + 1)
            }
            this.handleUpdate(update).catch((err) => {
              this.logger.error(
                `[tg] update ${update?.update_id} error: ${err.message}`
              )
            })
          }
        }
      } catch (err) {
        if (!this.running) break
        if (isConflictError(err)) {
          if (!conflictNoticeShown) {
            conflictNoticeShown = true
            this.logger.error(
              `[tg] 409 Conflict on getUpdates! Another process (likely Codeg built-in Telegram channel) is polling the same Bot Token. Disable the built-in channel in Codeg Desktop -> Settings -> Chat Channels.`
            )
          }
          await sleep(10000)
        } else {
          this.logger.warn(`[tg] getUpdates error: ${err.message}`)
          await sleep(1000)
        }
      }
    }
  }

  _isAuthorized(userId) {
    if (this.allowedUsers.size === 0) return false
    return this.allowedUsers.has(Number(userId))
  }

  async handleUpdate(update) {
    if (!update || typeof update !== "object") return
    if (update.message) {
      await this._handleMessage(update.message)
    } else if (update.callback_query) {
      await this._handleCallbackQuery(update.callback_query)
    }
  }

  async _handleMessage(msg) {
    const userId = msg?.from?.id
    const chatId = msg?.chat?.id
    if (!userId || !chatId) return

    if (!this._isAuthorized(userId)) {
      this.logger.warn(
        `[auth] rejected unauthorized message from user=${userId} chat=${chatId}`
      )
      return
    }

    this.state.setPrimaryChatId(chatId)
    const threadId = Number.isInteger(msg.message_thread_id)
      ? msg.message_thread_id
      : 0
    const rawText = (msg.text || msg.caption || "").trim()

    // Ignore Telegram service messages like forum_topic_created
    if (!rawText && !msg.photo && !msg.document) return

    // 1. Check pending reply-based inputs (free-text question answer / plan feedback)
    const replyMsgId = msg.reply_to_message?.message_id
    if (replyMsgId && rawText && !rawText.startsWith("/")) {
      if (
        await this._tryConsumePendingReply(
          chatId,
          threadId,
          replyMsgId,
          rawText
        )
      ) {
        return
      }
    }

    // 2. Commands
    if (rawText.startsWith("/")) {
      const [cmdToken, ...rest] = rawText.split(/\s+/)
      const cmd = cmdToken.split("@")[0].toLowerCase()
      const argsText = rest.join(" ").trim()
      await this._handleCommand({ cmd, argsText, chatId, threadId, msg })
      return
    }

    // 3. Regular prompt inside a thread or fallback chat
    await this._handlePromptMessage({ chatId, threadId, text: rawText, msg })
  }

  async _tryConsumePendingReply(chatId, threadId, replyMsgId, text) {
    const replyKey = this._replyKey(chatId, threadId, replyMsgId)
    const qKey = this.pendingQuestionReplyByMsgId.get(replyKey)
    if (qKey) {
      const card = this.questionCards.get(qKey)
      // Double check: the card must belong to the chat and topic the reply came from.
      if (card && this._ownsCard(card, chatId, threadId)) {
        const q = card.questions[card.currentIdx]
        if (q) {
          card.selectedMap[q.id] = [text]
          this.pendingQuestionReplyByMsgId.delete(replyKey)
          await this._advanceOrSubmitQuestion(card, chatId, threadId)
          return true
        }
      }
      this.pendingQuestionReplyByMsgId.delete(replyKey)
    }

    const pKey = this.pendingPlanFeedbackByMsgId.get(replyKey)
    if (pKey) {
      const card = this.planCards.get(pKey)
      if (card && this._ownsCard(card, chatId, threadId)) {
        this.pendingPlanFeedbackByMsgId.delete(replyKey)
        await this.codeg.acpAnswerPlanApproval({
          connectionId: card.connectionId,
          approvalId: card.approvalId,
          answer: { decision: "request_changes", feedback: text },
        })
        await this._markCardResolved(
          card.chatId,
          card.messageId,
          card.baseHtml,
          `✏️ 已提交修改意见：<i>${escapeHtml(truncateText(text, 120))}</i>`
        )
        this.planCards.delete(pKey)

        // Grok discards feedback on exit_plan_mode response, so follow-up prompt mirrors frontend
        const binding =
          this.state.findThreadByConnectionId(card.connectionId, {
            chatId: card.chatId,
          }) ||
          this.state.findThreadByConversationId(
            this.connMeta.get(card.connectionId)?.conversationId,
            { chatId: card.chatId }
          )
        const agentType =
          binding?.agentType || this.connMeta.get(card.connectionId)?.agentType
        if (agentType === "grok") {
          setTimeout(() => {
            this.codeg
              .acpPrompt({
                connectionId: card.connectionId,
                blocks: [{ type: "text", text }],
                folderId: binding?.folderId ?? null,
                conversationId: binding?.conversationId ?? null,
                clientMessageId: `tg-planfb-${Date.now()}`,
              })
              .catch(() => {})
          }, 350)
        }
        return true
      }
      this.pendingPlanFeedbackByMsgId.delete(replyKey)
    }

    return false
  }

  async _handleCommand({ cmd, argsText, chatId, threadId }) {
    switch (cmd) {
      case "/start":
      case "/help":
        return this._cmdHelp(chatId, threadId)
      case "/new":
        return this._cmdNew(chatId, threadId)
      case "/sessions":
        return this._cmdSessions(chatId, threadId, argsText, 0)
      case "/web":
        return this._cmdWeb(chatId, threadId)
      case "/active":
        return this._cmdActive(chatId, threadId)
      case "/mode":
        return this._cmdMode(chatId, threadId)
      case "/model":
        return this._cmdModel(chatId, threadId)
      case "/status":
        return this._cmdStatus(chatId, threadId)
      case "/history":
        return this._cmdHistory(chatId, threadId, argsText)
      case "/stop":
        return this._cmdStop(chatId, threadId)
      case "/rename":
        return this._cmdRename(chatId, threadId, argsText)
      case "/close":
        return this._cmdClose(chatId, threadId)
      default:
        await this.tg.sendMessage(
          chatId,
          `未知命令 <code>${escapeHtml(cmd)}</code>，发送 /help 查看可用命令。`,
          { threadId }
        )
    }
  }

  async _cmdHelp(chatId, threadId) {
    let online = false
    try {
      await this.codeg.health()
      online = true
    } catch {
      // offline
    }

    const binding = this.state.getThread(chatId, threadId)
    const statusDot = online ? "🟢 在线" : "🔴 离线"
    const sessionLine = binding
      ? `当前：<b>${escapeHtml(binding.folderName)} · ${escapeHtml(formatAgentBadge(binding.agentType))}</b>`
      : "尚未选择会话"

    const text = [
      `<b>Codeg</b>  ·  ${statusDot}`,
      sessionLine,
      "<i>直接发消息或截图即可对话，审批与提问会自动弹出。</i>",
    ].join("\n")

    const sidNew = this.state.registerCallback("quick_new", {
      targetThreadId: threadId,
      chatId,
      threadId,
    })
    const sidSess = this.state.registerCallback("quick_sessions", {
      chatId,
      threadId,
    })
    const keyboard = [
      [
        { text: "＋ 新建会话", callback_data: `qact:${sidNew}` },
        { text: "会话列表", callback_data: `qact:${sidSess}` },
      ],
    ]
    if (binding) {
      const sidMode = this.state.registerCallback("quick_mode", {
        chatId,
        threadId,
      })
      const sidModel = this.state.registerCallback("quick_model", {
        chatId,
        threadId,
      })
      keyboard.push([
        { text: "权限模式", callback_data: `qact:${sidMode}` },
        { text: "切换模型", callback_data: `qact:${sidModel}` },
      ])
    }
    const webUrl = this.miniAppUrl || this.tunnel?.getUrl()
    if (webUrl) {
      keyboard.push([
        { text: "📱 打开 Codeg 手机端", web_app: { url: webUrl } },
      ])
    }

    await this.tg.sendMessage(chatId, text, {
      threadId,
      replyMarkup: { inline_keyboard: keyboard },
    })
  }

  async _cmdWeb(chatId, threadId, editMessageId = null) {
    if (!this.webappProxy && !this.tunnel) {
      await this.tg.sendMessage(chatId, "Mini App 网页入口未启用。", {
        threadId,
      })
      return
    }

    const tunnelRunning = Boolean(this.tunnel?.isRunning())
    const url = this.tunnel?.getUrl() || this.miniAppUrl || ""
    const sessCount = this.webappProxy?.getSessionCount() ?? 0

    let stateLine
    if (!tunnelRunning) {
      stateLine = "🔴 公网入口已关闭（安全隔离中）"
    } else if (url) {
      stateLine = `🟢 已开启 · 仅限 Telegram 签名验证访问`
    } else {
      stateLine = "🟡 正在建立加密隧道…"
    }

    const lines = [
      "<b>Codeg 手机端面板</b>",
      stateLine,
      `已授权活跃网页会话：<b>${sessCount}</b>`,
    ]

    const keyboard = []
    if (tunnelRunning && url) {
      keyboard.push([{ text: "📱 打开 Codeg 手机端", web_app: { url } }])
    }

    const row2 = []
    if (sessCount > 0) {
      row2.push({ text: "🔒 踢出网页会话", callback_data: "web:revoke" })
    }
    if (tunnelRunning) {
      row2.push({
        text: this.tunnel?.mode === "named" ? "🔄 重连隧道" : "🔄 更换隧道地址",
        callback_data: "web:rotate",
      })
      row2.push({ text: "⏹ 关闭入口", callback_data: "web:stop" })
    } else {
      row2.push({ text: "▶ 开启手机面板", callback_data: "web:start" })
    }
    if (row2.length > 0) keyboard.push(row2)

    const html = lines.join("\n")
    if (editMessageId) {
      await this.tg.editMessageText(chatId, editMessageId, html, {
        replyMarkup: { inline_keyboard: keyboard },
      })
    } else {
      await this.tg.sendMessage(chatId, html, {
        threadId,
        replyMarkup: { inline_keyboard: keyboard },
      })
    }
  }

  async _getFoldersList() {
    let folders = await this.codeg.listOpenFolderDetails().catch(() => [])
    if (!Array.isArray(folders) || folders.length === 0) {
      folders = await this.codeg.listAllFolderDetails().catch(() => [])
    }
    const filtered = (folders || []).filter(
      (f) => f && f.kind !== "chat" && f.path && path.isAbsolute(f.path)
    )
    const list =
      filtered.length > 0
        ? filtered
        : (folders || []).filter((f) => f && f.kind !== "chat")
    return list.sort((a, b) =>
      String(b.last_opened_at || "").localeCompare(
        String(a.last_opened_at || "")
      )
    )
  }

  async _cmdNew(chatId, threadId, page = 0, editMessageId = null) {
    let folders
    try {
      folders = await this._getFoldersList()
    } catch (err) {
      await this.tg.sendMessage(
        chatId,
        `无法连接 Codeg：<code>${escapeHtml(err.message)}</code>`,
        {
          threadId,
        }
      )
      return
    }

    if (folders.length === 0) {
      await this.tg.sendMessage(
        chatId,
        "暂无可用项目目录，请先在 Codeg 桌面端打开一个文件夹。",
        { threadId }
      )
      return
    }

    const pageSize = 10
    const totalPages = Math.max(1, Math.ceil(folders.length / pageSize))
    const safePage = Math.max(0, Math.min(page, totalPages - 1))
    const slice = folders.slice(safePage * pageSize, (safePage + 1) * pageSize)

    // If user typed /new inside an existing UNBOUND DM topic, bind into that topic
    const existingBinding =
      threadId > 0 ? this.state.getThread(chatId, threadId) : null
    const targetThreadId = threadId > 0 && !existingBinding ? threadId : 0

    const keyboard = []
    let row = []
    for (const f of slice) {
      const label = f.alias || f.name
      const sid = this.state.registerCallback("new_folder", {
        folderId: f.id,
        folderName: label,
        workingDir: f.path,
        defaultAgentType: f.default_agent_type || null,
        targetThreadId,
        chatId,
        threadId,
      })
      row.push({ text: truncateText(label, 18), callback_data: `newf:${sid}` })
      if (row.length === 2) {
        keyboard.push(row)
        row = []
      }
    }
    if (row.length > 0) keyboard.push(row)

    const nav = []
    if (safePage > 0) {
      const prevId = this.state.registerCallback("new_folder_page", {
        page: safePage - 1,
        chatId,
        threadId,
      })
      nav.push({ text: "← 上一页", callback_data: `newfp:${prevId}` })
    }
    if (safePage + 1 < totalPages) {
      const nextId = this.state.registerCallback("new_folder_page", {
        page: safePage + 1,
        chatId,
        threadId,
      })
      nav.push({ text: "下一页 →", callback_data: `newfp:${nextId}` })
    }
    if (nav.length > 0) keyboard.push(nav)

    const pageInfo =
      totalPages > 1 ? `  <i>${safePage + 1}/${totalPages}</i>` : ""
    const html = `<b>新建会话</b> · 选择项目${pageInfo}`
    if (editMessageId) {
      await this.tg.editMessageText(chatId, editMessageId, html, {
        replyMarkup: { inline_keyboard: keyboard },
      })
    } else {
      await this.tg.sendMessage(chatId, html, {
        threadId,
        replyMarkup: { inline_keyboard: keyboard },
      })
    }
  }

  async _cmdSessions(
    chatId,
    threadId,
    search = "",
    page = 0,
    editMessageId = null
  ) {
    let conversations
    let folders
    let conns
    try {
      ;[conversations, folders, conns] = await Promise.all([
        this.codeg.listAllConversations(search ? { search } : {}),
        this.codeg.listAllFolderDetails(),
        this.codeg.acpListConnections().catch(() => []),
      ])
    } catch (err) {
      await this.tg.sendMessage(
        chatId,
        `获取会话失败：<code>${escapeHtml(err.message)}</code>`,
        {
          threadId,
        }
      )
      return
    }

    const foldersById = new Map((folders || []).map((f) => [f.id, f]))
    const liveConnByConvId = new Map()
    await Promise.all(
      (conns || []).map(async (c) => {
        const cachedConvId = this.connMeta.get(c.id)?.conversationId
        if (cachedConvId) {
          liveConnByConvId.set(cachedConvId, c.id)
          return
        }
        try {
          const snap = await this.codeg.acpGetSessionSnapshot(c.id)
          if (snap?.conversation_id) {
            this.connMeta.set(c.id, {
              ...(this.connMeta.get(c.id) || {}),
              conversationId: snap.conversation_id,
              folderId: snap.folder_id ?? null,
            })
            liveConnByConvId.set(snap.conversation_id, c.id)
          }
        } catch {
          // ignore
        }
      })
    )

    const threadByConvId = new Map()
    for (const t of this.state.listThreads({ chatId })) {
      if (t.conversationId) threadByConvId.set(t.conversationId, t)
    }

    const sorted = [...(conversations || [])].sort((a, b) => {
      const aLive =
        liveConnByConvId.has(a.id) || a.status === "in_progress" ? 1 : 0
      const bLive =
        liveConnByConvId.has(b.id) || b.status === "in_progress" ? 1 : 0
      if (aLive !== bLive) return bLive - aLive
      return String(b.updated_at || "").localeCompare(
        String(a.updated_at || "")
      )
    })

    const activeConvId =
      this.state.getThread(chatId, threadId)?.conversationId ?? null
    const { html, replyMarkup } = formatSessionList({
      conversations: sorted,
      foldersById,
      liveConnByConvId,
      threadByConvId,
      activeConvId,
      page,
      pageSize: 6,
      search,
      registerCallback: (kind, data) =>
        this.state.registerCallback(kind, { ...data, chatId, threadId }),
    })

    if (editMessageId) {
      await this.tg.editMessageText(chatId, editMessageId, html, {
        replyMarkup,
      })
    } else {
      await this.tg.sendMessage(chatId, html, { threadId, replyMarkup })
    }
  }

  async _cmdActive(chatId, threadId) {
    let conns
    try {
      conns = await this.codeg.acpListConnections()
    } catch (err) {
      await this.tg.sendMessage(
        chatId,
        `无法连接 Codeg：<code>${escapeHtml(err.message)}</code>`,
        {
          threadId,
        }
      )
      return
    }

    if (!conns || conns.length === 0) {
      await this.tg.sendMessage(chatId, "当前没有运行中的 Agent。", {
        threadId,
      })
      return
    }

    const snapshots = await Promise.all(
      conns.map((c) => this.codeg.acpGetSessionSnapshot(c.id).catch(() => null))
    )

    const lines = [`<b>运行中 (${conns.length})</b>`]
    const keyboard = []

    conns.forEach((c, idx) => {
      const snap = snapshots[idx]
      // Scope to this chat first, so another chat's topic title is never revealed.
      const binding =
        this.state.findThreadByConnectionId(c.id, { chatId }) ||
        (snap?.conversation_id
          ? this.state.findThreadByConversationId(snap.conversation_id, {
              chatId,
            })
          : null)
      const boundElsewhere = binding
        ? false
        : Boolean(
            this.state.findThreadByConnectionId(c.id) ||
            (snap?.conversation_id &&
              this.state.findThreadByConversationId(snap.conversation_id))
          )

      const flags = []
      if (snap?.pending_permission) flags.push("待审批")
      if (snap?.pending_question) flags.push("待回答")
      if (snap?.pending_plan_approval) flags.push("待批计划")
      const flagStr = flags.length > 0 ? `  <i>(${flags.join(" · ")})</i>` : ""

      const titlePart =
        binding?.title ||
        this.connMeta.get(c.id)?.folderName ||
        formatAgentBadge(c.agent_type)
      const agent = formatAgentBadge(c.agent_type)
      const label = titlePart === agent ? agent : `${titlePart} · ${agent}`

      lines.push(`🟢 <b>${escapeHtml(truncateText(label, 36))}</b>${flagStr}`)

      if (!binding && snap?.conversation_id && !boundElsewhere) {
        const sid = this.state.registerCallback("open_conv", {
          conversationId: snap.conversation_id,
          chatId,
          threadId,
        })
        keyboard.push([
          {
            text: `接管 · ${truncateText(label, 28)}`,
            callback_data: `sess:${sid}`,
          },
        ])
      }
    })

    await this.tg.sendMessage(chatId, lines.join("\n"), {
      threadId,
      replyMarkup:
        keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    })
  }

  _requireBoundThread(chatId, threadId) {
    const binding = this.state.getThread(chatId, threadId)
    if (!binding) {
      this._sendUnboundHint(chatId, threadId).catch(() => {})
      return null
    }
    return binding
  }

  async _sendUnboundHint(chatId, threadId) {
    const sidNew = this.state.registerCallback("quick_new", {
      targetThreadId: threadId,
      chatId,
      threadId,
    })
    const sidSess = this.state.registerCallback("quick_sessions", {
      chatId,
      threadId,
    })
    await this.tg.sendMessage(
      chatId,
      "尚未选择会话，请先新建或切换一个会话：",
      {
        threadId,
        replyMarkup: {
          inline_keyboard: [
            [
              { text: "＋ 新建会话", callback_data: `qact:${sidNew}` },
              { text: "会话列表", callback_data: `qact:${sidSess}` },
            ],
          ],
        },
      }
    )
  }

  async _cmdMode(chatId, threadId, editMessageId = null) {
    const binding = this._requireBoundThread(chatId, threadId)
    if (!binding) return

    let connectionId
    try {
      connectionId = await this._ensureConnection(binding, {
        waitForSnapshotMs: 2500,
      })
    } catch (err) {
      await this.tg.sendMessage(
        chatId,
        `连接会话失败：<code>${escapeHtml(err.message)}</code>`,
        {
          threadId,
        }
      )
      return
    }

    const modes = this.connModes.get(connectionId)
    if (
      !modes ||
      !Array.isArray(modes.available_modes) ||
      modes.available_modes.length === 0
    ) {
      await this.tg.sendMessage(chatId, "当前 Agent 不支持切换运行模式。", {
        threadId,
      })
      return
    }

    const sid = this.state.registerCallback("set_mode", {
      connectionId,
      modes: modes.available_modes.map((m) => ({ id: m.id, name: m.name })),
      chatId,
      threadId,
    })

    const useCols =
      modes.available_modes.length > 2 &&
      modes.available_modes.every((m) => (m.name || m.id).length <= 16)
    const keyboard = []
    let row = []
    modes.available_modes.forEach((m, idx) => {
      const active = m.id === modes.current_mode_id ? "✓ " : ""
      const btn = {
        text: `${active}${truncateText(m.name || m.id, 30)}`,
        callback_data: `mode:${sid}:${idx}`,
      }
      if (useCols) {
        row.push(btn)
        if (row.length === 2) {
          keyboard.push(row)
          row = []
        }
      } else {
        keyboard.push([btn])
      }
    })
    if (row.length > 0) keyboard.push(row)

    const curMode = modes.available_modes.find(
      (m) => m.id === modes.current_mode_id
    )
    const curLabel = curMode?.name || modes.current_mode_id
    const html = `<b>权限模式</b>  <i>(当前：${escapeHtml(curLabel)})</i>`
    if (editMessageId) {
      await this.tg.editMessageText(chatId, editMessageId, html, {
        replyMarkup: { inline_keyboard: keyboard },
      })
    } else {
      await this.tg.sendMessage(chatId, html, {
        threadId,
        replyMarkup: { inline_keyboard: keyboard },
      })
    }
  }

  async _cmdModel(chatId, threadId, editMessageId = null) {
    const binding = this._requireBoundThread(chatId, threadId)
    if (!binding) return

    let connectionId
    try {
      connectionId = await this._ensureConnection(binding, {
        waitForSnapshotMs: 2500,
      })
    } catch (err) {
      await this.tg.sendMessage(
        chatId,
        `连接会话失败：<code>${escapeHtml(err.message)}</code>`,
        {
          threadId,
        }
      )
      return
    }

    const options = (this.connConfigOptions.get(connectionId) || []).filter(
      (opt) =>
        opt?.kind?.type === "select" &&
        Array.isArray(opt.kind.options) &&
        opt.kind.options.length > 0
    )

    if (options.length === 0) {
      await this.tg.sendMessage(chatId, "当前 Agent 未提供可切换的模型选项。", {
        threadId,
      })
      return
    }

    const sid = this.state.registerCallback("set_cfg", {
      connectionId,
      options: options.map((o) => ({
        id: o.id,
        name: o.name,
        current_value: o.kind.current_value,
        values: o.kind.options
          .slice(0, 20)
          .map((v) => ({ value: v.value, name: v.name })),
      })),
      chatId,
      threadId,
    })

    await this._renderConfigOptionMenu(chatId, threadId, sid, 0, editMessageId)
  }

  async _renderConfigOptionMenu(chatId, threadId, sid, optIdx, editMessageId) {
    const entry = this.state.getCallback(sid)
    if (!entry) return
    if (!this._ownsCallback(entry, chatId, threadId)) return
    const opts = entry.data.options || []
    const opt = opts[optIdx] || opts[0]
    if (!opt) return

    const keyboard = []
    if (opts.length > 1) {
      keyboard.push(
        opts.map((o, i) => ({
          text: `${i === optIdx ? "• " : ""}${truncateText(o.name || o.id, 18)}`,
          callback_data: `cfgopt:${sid}:${i}`,
        }))
      )
    }

    const useCols =
      opt.values.length > 3 &&
      opt.values.every((v) => (v.name || v.value).length <= 14)
    let row = []
    opt.values.forEach((v, valIdx) => {
      const active = v.value === opt.current_value ? "✓ " : ""
      const btn = {
        text: `${active}${truncateText(v.name || v.value, 32)}`,
        callback_data: `cfgval:${sid}:${optIdx}:${valIdx}`,
      }
      if (useCols) {
        row.push(btn)
        if (row.length === 2) {
          keyboard.push(row)
          row = []
        }
      } else {
        keyboard.push([btn])
      }
    })
    if (row.length > 0) keyboard.push(row)

    const curOpt = opt.values.find((v) => v.value === opt.current_value)
    const curName = curOpt?.name || opt.current_value
    const html = `<b>${escapeHtml(opt.name || opt.id)}</b>  <i>(当前：${escapeHtml(curName)})</i>`
    if (editMessageId) {
      await this.tg.editMessageText(chatId, editMessageId, html, {
        replyMarkup: { inline_keyboard: keyboard },
      })
    } else {
      await this.tg.sendMessage(chatId, html, {
        threadId,
        replyMarkup: { inline_keyboard: keyboard },
      })
    }
  }

  async _cmdStatus(chatId, threadId) {
    let online = false
    try {
      await this.codeg.health()
      online = true
    } catch {
      // offline
    }

    const binding = this.state.getThread(chatId, threadId)
    if (!binding) {
      const sidNew = this.state.registerCallback("quick_new", {
        targetThreadId: threadId,
        chatId,
        threadId,
      })
      const sidSess = this.state.registerCallback("quick_sessions", {
        chatId,
        threadId,
      })
      await this.tg.sendMessage(
        chatId,
        `<b>Codeg</b>  ·  ${online ? "🟢 在线" : "🔴 离线"}\n当前未绑定会话`,
        {
          threadId,
          replyMarkup: {
            inline_keyboard: [
              [
                { text: "＋ 新建会话", callback_data: `qact:${sidNew}` },
                { text: "会话列表", callback_data: `qact:${sidSess}` },
              ],
            ],
          },
        }
      )
      return
    }

    const modeInfo = binding.connectionId
      ? this.connModes.get(binding.connectionId)
      : null
    const curModeObj = modeInfo?.available_modes?.find(
      (m) => m.id === modeInfo.current_mode_id
    )
    const modeName = curModeObj?.name || modeInfo?.current_mode_id

    const metaParts = [online ? "🟢 在线" : "🔴 离线"]
    if (modeName) metaParts.push(modeName)
    metaParts.push(binding.threadId > 0 ? "独立话题" : "通用窗口")

    const lines = [
      `<b>${escapeHtml(binding.folderName)} · ${escapeHtml(formatAgentBadge(binding.agentType))}</b>`,
      metaParts.map((p) => escapeHtml(p)).join("  ·  "),
    ]
    if (binding.workingDir) {
      lines.push(`<code>${escapeHtml(binding.workingDir)}</code>`)
    }

    const sidMode = this.state.registerCallback("quick_mode", {
      chatId,
      threadId,
    })
    const sidModel = this.state.registerCallback("quick_model", {
      chatId,
      threadId,
    })
    const sidHist = this.state.registerCallback("quick_history", {
      chatId,
      threadId,
    })

    await this.tg.sendMessage(chatId, lines.join("\n"), {
      threadId,
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "权限模式", callback_data: `qact:${sidMode}` },
            { text: "模型", callback_data: `qact:${sidModel}` },
            { text: "最近记录", callback_data: `qact:${sidHist}` },
          ],
        ],
      },
    })
  }

  async _cmdHistory(chatId, threadId, argsText) {
    const binding = this._requireBoundThread(chatId, threadId)
    if (!binding || !binding.conversationId) return

    const count = Math.max(1, Math.min(12, Number.parseInt(argsText, 10) || 4))
    let detail
    try {
      detail = await this.codeg.getFolderConversation(
        binding.conversationId,
        count
      )
    } catch (err) {
      await this.tg.sendMessage(
        chatId,
        `读取记录失败：<code>${escapeHtml(err.message)}</code>`,
        {
          threadId,
        }
      )
      return
    }

    const turns = Array.isArray(detail?.turns) ? detail.turns : []
    if (turns.length === 0) {
      await this.tg.sendMessage(chatId, "当前会话暂无对话记录。", { threadId })
      return
    }

    const agentName = formatAgentBadge(binding.agentType)
    const parts = []
    for (const turn of turns) {
      const blocks = Array.isArray(turn.blocks) ? turn.blocks : []
      const textBlocks = blocks
        .filter((b) => b?.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n")
        .trim()

      if (turn.role === "user") {
        const snippet = truncateText(textBlocks || "[图片/附件]", 500)
        parts.push(`<b>你</b>\n<blockquote>${escapeHtml(snippet)}</blockquote>`)
      } else {
        const body = textBlocks
          ? mdToTelegramHtml(truncateText(textBlocks, 750))
          : "<i>[执行了工具操作]</i>"
        parts.push(`<b>${escapeHtml(agentName)}</b>\n${body}`)
      }
    }

    const joined = parts.join("\n\n")
    if (joined.length <= this.cfg.maxMessageChars) {
      await this.tg.sendMessage(chatId, joined, { threadId })
    } else {
      await this.tg.sendMessage(
        chatId,
        truncateText(joined, this.cfg.maxMessageChars),
        { threadId }
      )
    }
  }

  async _cmdStop(chatId, threadId) {
    const binding = this._requireBoundThread(chatId, threadId)
    if (!binding) return

    let connId = binding.connectionId
    if (!connId && binding.conversationId) {
      try {
        const found = await this.codeg.acpFindConnectionForConversation({
          conversationId: binding.conversationId,
          sessionId: binding.externalId,
          agentType: binding.agentType,
        })
        connId = found?.connection_id || null
      } catch {
        // ignore
      }
    }

    if (!connId) {
      await this.tg.sendMessage(chatId, "当前没有正在运行的任务。", {
        threadId,
      })
      return
    }

    try {
      await this.codeg.acpCancel(connId)
      this._stopTyping(connId)
      await this.tg.sendMessage(chatId, "已中止当前输出。", { threadId })
    } catch (err) {
      await this.tg.sendMessage(
        chatId,
        `中止失败：<code>${escapeHtml(err.message)}</code>`,
        {
          threadId,
        }
      )
    }
  }

  async _cmdRename(chatId, threadId, newTitle) {
    const binding = this._requireBoundThread(chatId, threadId)
    if (!binding) return
    if (!newTitle) {
      await this.tg.sendMessage(chatId, "用法：<code>/rename 新标题</code>", {
        threadId,
      })
      return
    }

    try {
      if (binding.conversationId) {
        await this.codeg.updateConversationTitle({
          conversationId: binding.conversationId,
          title: newTitle,
        })
      }
      const topicTitle = `${binding.folderName || "Codeg"} · ${newTitle}`
      if (binding.threadId > 0) {
        await this.tg
          .editForumTopic(chatId, binding.threadId, { name: topicTitle })
          .catch(() => {})
      }
      this.state.updateThread(binding.chatId, binding.threadId, {
        title: newTitle,
      })
      await this.tg.sendMessage(
        chatId,
        `✓ 已重命名为 <b>${escapeHtml(newTitle)}</b>`,
        {
          threadId,
        }
      )
    } catch (err) {
      await this.tg.sendMessage(
        chatId,
        `重命名失败：<code>${escapeHtml(err.message)}</code>`,
        {
          threadId,
        }
      )
    }
  }

  async _cmdClose(chatId, threadId) {
    const binding = this._requireBoundThread(chatId, threadId)
    if (!binding) return

    const sid = this.state.registerCallback("close_topic", {
      threadId: binding.threadId,
      conversationId: binding.conversationId,
      connectionId: binding.connectionId,
      chatId,
    })

    const title = binding.title || binding.folderName || "当前会话"
    await this.tg.sendMessage(
      chatId,
      `确认关闭 <b>${escapeHtml(truncateText(title, 36))}</b>？`,
      {
        threadId,
        replyMarkup: {
          inline_keyboard: [
            [
              { text: "仅解绑", callback_data: `cls:${sid}:topic` },
              { text: "删除会话", callback_data: `cls:${sid}:delete` },
              { text: "取消", callback_data: `cls:${sid}:cancel` },
            ],
          ],
        },
      }
    )
  }

  async _createSessionTopic(chatId, topicName) {
    try {
      const res = await this.tg.createForumTopic(chatId, topicName)
      this.state.setThreadedModeSupported(true, chatId)
      return Number(res.message_thread_id)
    } catch (err) {
      if (isTopicDisabledError(err)) {
        this.state.setThreadedModeSupported(false, chatId)
        return 0
      }
      throw err
    }
  }

  async _handlePromptMessage({ chatId, threadId, text, msg }) {
    const binding = this.state.getThread(chatId, threadId)
    if (!binding) {
      await this._sendUnboundHint(chatId, threadId)
      return
    }

    const blocks = []
    if (text) blocks.push({ type: "text", text })

    if (Array.isArray(msg.photo) && msg.photo.length > 0) {
      try {
        const largest = msg.photo[msg.photo.length - 1]
        const fileInfo = await this.tg.getFile(largest.file_id)
        const buf = await this.tg.downloadFile(fileInfo.file_path)
        blocks.push({
          type: "image",
          data: buf.toString("base64"),
          mime_type: "image/jpeg",
        })
      } catch (err) {
        await this.tg.sendMessage(
          chatId,
          `⚠️ 图片下载失败：<code>${escapeHtml(err.message)}</code>`,
          {
            threadId,
          }
        )
        if (blocks.length === 0) return
      }
    }

    if (blocks.length === 0) return

    let connectionId
    try {
      connectionId = await this._ensureConnection(binding, {
        waitForSnapshotMs: 1500,
      })
    } catch (err) {
      await this.tg.sendMessage(
        chatId,
        `❌ 无法启动/连接 Agent：<code>${escapeHtml(err.message)}</code>`,
        { threadId }
      )
      return
    }

    try {
      this._initTurnStream(connectionId, chatId, binding.threadId, binding)
      this._startTyping(connectionId, chatId, binding.threadId)
      await this.codeg.acpPrompt({
        connectionId,
        blocks,
        folderId: binding.folderId,
        conversationId: binding.conversationId,
        clientMessageId: `tg-${msg.message_id || Date.now()}`,
      })
    } catch (err) {
      this._stopTyping(connectionId)
      this.turnStreams.delete(connectionId)
      if (isTurnInProgressError(err)) {
        const sid = this.state.registerCallback("stop_conn", {
          connectionId,
          chatId,
          threadId,
        })
        await this.tg.sendMessage(
          chatId,
          "⏳ 当前回合仍在执行中，请稍候或先中止当前回合。",
          {
            threadId,
            replyMarkup: {
              inline_keyboard: [
                [{ text: "⏹ 中止当前回合", callback_data: `stop:${sid}` }],
              ],
            },
          }
        )
      } else {
        await this.tg.sendMessage(
          chatId,
          `❌ 发送消息失败：<code>${escapeHtml(err.message)}</code>`,
          { threadId }
        )
      }
    }
  }

  async _ensureConnection(binding, { waitForSnapshotMs = 0 } = {}) {
    if (binding.connectionId) {
      const conns = await this.codeg.acpListConnections().catch(() => [])
      if (
        conns.some(
          (c) => c.id === binding.connectionId && c.status !== "disconnected"
        )
      ) {
        this.codeg.attach(binding.connectionId)
        return binding.connectionId
      }
    }

    if (binding.conversationId) {
      const found = await this.codeg
        .acpFindConnectionForConversation({
          conversationId: binding.conversationId,
          sessionId: binding.externalId,
          agentType: binding.agentType,
        })
        .catch(() => null)
      if (found?.connection_id) {
        this.state.updateThread(binding.chatId, binding.threadId, {
          connectionId: found.connection_id,
        })
        this.connMeta.set(found.connection_id, {
          conversationId: binding.conversationId,
          folderId: binding.folderId,
          folderName: binding.folderName,
          agentType: binding.agentType,
        })
        const waitPromise =
          waitForSnapshotMs > 0
            ? this._waitForSnapshot(found.connection_id, waitForSnapshotMs)
            : null
        this.codeg.attach(found.connection_id)
        if (waitPromise) await waitPromise
        return found.connection_id
      }
    }

    const connectionId = await this.codeg.acpConnect({
      agentType: binding.agentType,
      workingDir: binding.workingDir,
      sessionId: binding.externalId || null,
    })
    this.state.updateThread(binding.chatId, binding.threadId, { connectionId })
    this.connMeta.set(connectionId, {
      conversationId: binding.conversationId,
      folderId: binding.folderId,
      folderName: binding.folderName,
      agentType: binding.agentType,
    })

    const waitPromise =
      waitForSnapshotMs > 0
        ? this._waitForSnapshot(connectionId, waitForSnapshotMs)
        : null
    this.codeg.attach(connectionId)
    if (waitPromise) await waitPromise
    return connectionId
  }

  _waitForSnapshot(connectionId, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      const list = this.snapshotWaiters.get(connectionId) || []
      list.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
      this.snapshotWaiters.set(connectionId, list)
    })
  }

  _resolveSnapshotWaiters(connectionId) {
    const list = this.snapshotWaiters.get(connectionId)
    if (!list) return
    this.snapshotWaiters.delete(connectionId)
    for (const fn of list) fn()
  }

  _initTurnStream(connectionId, chatId, threadId, binding) {
    const prev = this.turnStreams.get(connectionId)
    if (prev?.timer) clearTimeout(prev.timer)
    this.turnStreams.set(connectionId, {
      connectionId,
      chatId,
      threadId,
      agentLabel: formatAgentBadge(binding.agentType),
      sessionLabel: `${binding.folderName || "Codeg"} · ${formatAgentBadge(binding.agentType)}`,
      startedAt: Date.now(),
      text: "",
      thinkingChars: 0,
      toolCalls: [],
      messageId: null,
      lastEditAt: 0,
      timer: null,
      sendingPromise: null,
    })
  }

  _startTyping(connectionId, chatId, threadId) {
    this._stopTyping(connectionId)
    this.tg.sendChatAction(chatId, "typing", { threadId })
    const timer = setInterval(() => {
      this.tg.sendChatAction(chatId, "typing", { threadId })
    }, 4500)
    timer.unref?.()
    this.typingTimers.set(connectionId, timer)
  }

  _stopTyping(connectionId) {
    const timer = this.typingTimers.get(connectionId)
    if (timer) {
      clearInterval(timer)
      this.typingTimers.delete(connectionId)
    }
  }

  async _handleSnapshot(connectionId, snapshot) {
    this._resolveSnapshotWaiters(connectionId)
    if (!snapshot) return

    const existingMeta = this.connMeta.get(connectionId) || {}
    this.connMeta.set(connectionId, {
      ...existingMeta,
      conversationId:
        snapshot.conversation_id ?? existingMeta.conversationId ?? null,
      folderId: snapshot.folder_id ?? existingMeta.folderId ?? null,
    })

    if (snapshot.modes) {
      this.connModes.set(connectionId, snapshot.modes)
    }
    if (Array.isArray(snapshot.config_options)) {
      this.connConfigOptions.set(connectionId, snapshot.config_options)
    }

    if (snapshot.conversation_id) {
      const patch = { connectionId }
      if (snapshot.external_id) patch.externalId = snapshot.external_id
      // Only the binding already tied to this connection may adopt the snapshot's
      // conversation; otherwise two chats sharing a conversation id would collide.
      const own = this.state.findThreadByConnectionId(connectionId)
      if (own) {
        this.state.updateThread(own.chatId, own.threadId, patch)
      } else {
        this.state.updateThreadByConversationId(snapshot.conversation_id, patch)
      }
    }

    if (snapshot.pending_permission) {
      await this._surfacePermissionRequest(connectionId, {
        request_id: snapshot.pending_permission.request_id,
        tool_call: snapshot.pending_permission.tool_call,
        options: snapshot.pending_permission.options || [],
        queued: snapshot.pending_permission.queued || 0,
      })
    }
    if (snapshot.pending_question) {
      await this._surfaceQuestionRequest(connectionId, {
        question_id: snapshot.pending_question.question_id,
        questions: snapshot.pending_question.questions || [],
      })
    }
    if (snapshot.pending_plan_approval) {
      await this._surfacePlanApprovalRequest(connectionId, {
        approval_id: snapshot.pending_plan_approval.approval_id,
        tool_call_id: snapshot.pending_plan_approval.tool_call_id,
        plan_markdown: snapshot.pending_plan_approval.plan_markdown || "",
      })
    }
  }

  async _handleAcpEvent(connectionId, envelope) {
    if (!envelope || !envelope.type) return

    switch (envelope.type) {
      case "session_started": {
        const binding = this.state.findThreadByConnectionId(connectionId)
        if (binding && envelope.session_id) {
          this.state.updateThread(binding.chatId, binding.threadId, {
            externalId: envelope.session_id,
          })
        }
        return
      }

      case "conversation_linked": {
        const meta = this.connMeta.get(connectionId) || {}
        this.connMeta.set(connectionId, {
          ...meta,
          conversationId: envelope.conversation_id,
          folderId: envelope.folder_id,
        })
        const binding = this.state.findThreadByConnectionId(connectionId)
        if (binding) {
          this.state.updateThread(binding.chatId, binding.threadId, {
            conversationId: envelope.conversation_id,
            folderId: envelope.folder_id,
          })
        }
        return
      }

      case "session_modes":
        if (envelope.modes) this.connModes.set(connectionId, envelope.modes)
        return

      case "mode_changed": {
        const modes = this.connModes.get(connectionId)
        if (modes && envelope.mode_id) {
          modes.current_mode_id = envelope.mode_id
        }
        return
      }

      case "session_config_options":
        if (Array.isArray(envelope.config_options)) {
          this.connConfigOptions.set(connectionId, envelope.config_options)
        }
        return

      case "content_delta": {
        if (envelope.parent_tool_use_id) return
        const stream = this.turnStreams.get(connectionId)
        if (!stream) return
        stream.text += envelope.text || ""
        this._scheduleStreamFlush(stream)
        return
      }

      case "thinking": {
        if (envelope.parent_tool_use_id) return
        const stream = this.turnStreams.get(connectionId)
        if (!stream) return
        stream.thinkingChars += (envelope.text || "").length
        this._scheduleStreamFlush(stream)
        return
      }

      case "tool_call": {
        const stream = this.turnStreams.get(connectionId)
        if (!stream) return
        stream.toolCalls.push({
          id: envelope.tool_call_id,
          label: envelope.title || envelope.kind || "tool",
          kind: envelope.kind,
          status: envelope.status || "in_progress",
        })
        this._scheduleStreamFlush(stream)
        return
      }

      case "tool_call_update": {
        const stream = this.turnStreams.get(connectionId)
        if (!stream) return
        const found = stream.toolCalls.find(
          (t) => t.id === envelope.tool_call_id
        )
        if (found) {
          if (envelope.title) found.label = envelope.title
          if (envelope.status) found.status = envelope.status
        }
        this._scheduleStreamFlush(stream)
        return
      }

      case "permission_request":
        await this._surfacePermissionRequest(connectionId, envelope)
        return

      case "permission_resolved":
        await this._handlePermissionResolved(connectionId, envelope)
        return

      case "question_request":
        await this._surfaceQuestionRequest(connectionId, envelope)
        return

      case "question_resolved":
        await this._handleQuestionResolved(connectionId, envelope)
        return

      case "plan_approval_request":
        await this._surfacePlanApprovalRequest(connectionId, envelope)
        return

      case "plan_approval_resolved":
        await this._handlePlanApprovalResolved(connectionId, envelope)
        return

      case "turn_complete":
        await this._finalizeTurnStream(connectionId)
        return

      case "error":
      case "session_load_failed": {
        this._stopTyping(connectionId)
        const target = await this._resolveTargetForConnection(connectionId)
        const stream = this.turnStreams.get(connectionId)
        if (stream) {
          if (stream.timer) clearTimeout(stream.timer)
          this.turnStreams.delete(connectionId)
        }
        if (
          target &&
          (stream || this.state.findThreadByConnectionId(connectionId))
        ) {
          await this.tg.sendMessage(
            target.chatId,
            `❌ <b>Agent 报错</b> (<code>${escapeHtml(envelope.code || envelope.type)}</code>)\n${escapeHtml(truncateText(envelope.message || "Unknown error", 1500))}`,
            { threadId: target.threadId }
          )
        }
        return
      }

      default:
        return
    }
  }

  _scheduleStreamFlush(stream) {
    if (stream.timer) return
    const elapsed = Date.now() - stream.lastEditAt
    const throttle = this.cfg.streamThrottleMs ?? 1200
    const wait = Math.max(80, throttle - elapsed)
    stream.timer = setTimeout(() => {
      stream.timer = null
      this._flushStreamPreview(stream).catch(() => {})
    }, wait)
    stream.timer.unref?.()
  }

  async _flushStreamPreview(stream) {
    if (!this.turnStreams.has(stream.connectionId)) return
    const elapsedSec = Math.max(
      1,
      Math.round((Date.now() - stream.startedAt) / 1000)
    )
    const html = formatStreamingMessage({
      agentLabel: stream.agentLabel,
      toolCalls: stream.toolCalls,
      text: stream.text,
      thinkingChars: stream.thinkingChars,
      elapsedSec,
    })

    stream.lastEditAt = Date.now()
    if (!stream.messageId) {
      if (!stream.sendingPromise) {
        stream.sendingPromise = this.tg
          .sendMessage(stream.chatId, html, {
            threadId: stream.threadId,
            disableNotification: true,
          })
          .then((sent) => {
            if (sent?.message_id) stream.messageId = sent.message_id
          })
          .finally(() => {
            stream.sendingPromise = null
          })
      }
      await stream.sendingPromise
    } else {
      await this.tg.editMessageText(stream.chatId, stream.messageId, html)
    }
  }

  async _finalizeTurnStream(connectionId) {
    this._stopTyping(connectionId)
    const stream = this.turnStreams.get(connectionId)
    if (!stream) return
    if (stream.timer) {
      clearTimeout(stream.timer)
      stream.timer = null
    }
    if (stream.sendingPromise) {
      await stream.sendingPromise.catch(() => {})
    }
    this.turnStreams.delete(connectionId)

    const elapsedSec = Math.max(
      1,
      Math.round((Date.now() - stream.startedAt) / 1000)
    )
    const body = stream.text.trim()
    const maxChars = this.cfg.maxMessageChars || 3800

    if (!body) {
      const toolPart =
        stream.toolCalls.length > 0
          ? ` · ${stream.toolCalls.length} 步工具`
          : ""
      const doneHtml = `✓ 完成 <i>(${elapsedSec}s${toolPart})</i>`
      if (stream.messageId) {
        await this.tg.editMessageText(stream.chatId, stream.messageId, doneHtml)
      } else {
        await this.tg.sendMessage(stream.chatId, doneHtml, {
          threadId: stream.threadId,
        })
      }
      return
    }

    if (body.length > 12000) {
      const summaryHtml = `${mdToTelegramHtml(truncateText(body, 2200))}\n\n<i>完整回复见附件 reply.md（${body.length} 字）</i>`
      if (stream.messageId) {
        await this.tg.editMessageText(
          stream.chatId,
          stream.messageId,
          summaryHtml
        )
      } else {
        await this.tg.sendMessage(stream.chatId, summaryHtml, {
          threadId: stream.threadId,
        })
      }
      await this.tg.sendDocument(stream.chatId, "reply.md", body, {
        threadId: stream.threadId,
      })
      return
    }

    const mdChunks = splitMarkdownForTelegram(body, maxChars)
    const firstHtml = mdToTelegramHtml(mdChunks[0])
    if (stream.messageId) {
      await this.tg.editMessageText(stream.chatId, stream.messageId, firstHtml)
    } else {
      await this.tg.sendMessage(stream.chatId, firstHtml, {
        threadId: stream.threadId,
      })
    }
    for (let i = 1; i < mdChunks.length; i++) {
      await this.tg.sendMessage(stream.chatId, mdToTelegramHtml(mdChunks[i]), {
        threadId: stream.threadId,
      })
    }
  }

  async _resolveTargetForConnection(connectionId) {
    const binding = this.state.findThreadByConnectionId(connectionId)
    if (binding) {
      return {
        chatId: binding.chatId,
        threadId: binding.threadId,
        bound: true,
        conversationId: binding.conversationId,
        sessionLabel: `${binding.folderName || "Codeg"} · ${formatAgentBadge(binding.agentType)}`,
      }
    }

    let meta = this.connMeta.get(connectionId)
    if (!meta?.conversationId) {
      try {
        const snap = await this.codeg.acpGetSessionSnapshot(connectionId)
        if (snap) {
          meta = {
            ...meta,
            conversationId: snap.conversation_id ?? null,
            folderId: snap.folder_id ?? null,
          }
          this.connMeta.set(connectionId, meta)
        }
      } catch {
        // ignore
      }
    }

    if (meta?.conversationId) {
      const byConv = this.state.findThreadByConversationId(meta.conversationId)
      if (byConv) {
        this.state.updateThread(byConv.chatId, byConv.threadId, {
          connectionId,
        })
        return {
          chatId: byConv.chatId,
          threadId: byConv.threadId,
          bound: true,
          conversationId: byConv.conversationId,
          sessionLabel: `${byConv.folderName || "Codeg"} · ${formatAgentBadge(byConv.agentType)}`,
        }
      }
    }

    // Desktop-originated request with no binding: deliver only when exactly one chat
    // is known. With several chats the owner is unknowable, and guessing would push
    // another user's prompt/approval into the wrong private chat.
    const knownChats = this.state.getKnownChatIds()
    if (knownChats.length > 1) {
      this.logger.warn(
        `[sync] ${knownChats.length} chats known; refusing to guess the owner of desktop connection ${connectionId}`
      )
      return null
    }
    const chatId = knownChats[0] ?? this.state.getPrimaryChatId()
    if (!chatId) return null
    return {
      chatId,
      threadId: 0,
      bound: false,
      conversationId: meta?.conversationId ?? null,
      sessionLabel: `桌面端 · ${formatAgentBadge(meta?.agentType || "agent")}`,
    }
  }

  async _sendWithThreadFallback(target, sendFn) {
    try {
      return await sendFn(target.threadId)
    } catch (err) {
      if (target.threadId > 0 && isThreadNotFoundError(err)) {
        this.logger.warn(
          `[tg] topic ${target.threadId} missing in Telegram, unbinding and falling back to main chat`
        )
        this.state.unbindThread(target.chatId, target.threadId)
        target.threadId = 0
        target.bound = false
        return await sendFn(0)
      }
      throw err
    }
  }

  async _surfacePermissionRequest(connectionId, payload) {
    const requestId = payload?.request_id
    if (!requestId) return
    const cardKey = `${connectionId}:${requestId}`
    if (this.permissionCards.has(cardKey)) return

    const target = await this._resolveTargetForConnection(connectionId)
    if (!target) return

    const options = Array.isArray(payload.options) ? payload.options : []
    const shortId = this.state.registerCallback("perm", {
      connectionId,
      requestId,
      cardKey,
      options: options.map((o) => ({
        option_id: o.option_id,
        name: o.name,
        kind: o.kind,
      })),
      chatId: target.chatId,
      threadId: target.threadId,
    })

    const { html, replyMarkup } = formatPermissionCard({
      toolCall: payload.tool_call,
      options,
      queued: payload.queued || 0,
      sessionLabel: target.sessionLabel,
      showSession: !target.bound,
      shortId,
    })

    if (!target.bound && target.conversationId) {
      const adoptSid = this.state.registerCallback("open_conv", {
        conversationId: target.conversationId,
        chatId: target.chatId,
        threadId: target.threadId,
      })
      replyMarkup.inline_keyboard.push([
        { text: "切到此会话", callback_data: `sess:${adoptSid}` },
      ])
    }

    const sent = await this._sendWithThreadFallback(target, (tid) =>
      this.tg.sendMessage(target.chatId, html, {
        threadId: tid,
        replyMarkup,
      })
    )

    this.permissionCards.set(cardKey, {
      connectionId,
      requestId,
      chatId: target.chatId,
      threadId: target.threadId,
      messageId: sent?.message_id || null,
      options,
      shortId,
      baseHtml: html,
    })
  }

  async _handlePermissionResolved(connectionId, envelope) {
    const cardKey = `${connectionId}:${envelope.request_id}`
    const card = this.permissionCards.get(cardKey)
    if (!card) return
    this.permissionCards.delete(cardKey)
    this.state.deleteCallback(card.shortId)

    const opt = card.options.find((o) => o.option_id === envelope.option_id)
    const originKind = envelope.origin?.kind
    let statusLine
    if (!envelope.option_id) {
      statusLine = "<i>已取消</i>"
    } else if (originKind === "user") {
      statusLine = `<i>💻 桌面端已处理 · ${escapeHtml(opt?.name || envelope.option_id)}</i>`
    } else {
      statusLine = `<i>✓ 已处理 · ${escapeHtml(opt?.name || envelope.option_id)}</i>`
    }
    await this._markCardResolved(
      card.chatId,
      card.messageId,
      card.baseHtml,
      statusLine
    )
  }

  async _surfaceQuestionRequest(connectionId, payload) {
    const questionId = payload?.question_id
    if (!questionId) return
    const cardKey = `${connectionId}:${questionId}`
    if (this.questionCards.has(cardKey)) return

    const target = await this._resolveTargetForConnection(connectionId)
    if (!target) return

    const questions = Array.isArray(payload.questions) ? payload.questions : []
    const shortId = this.state.registerCallback("question", {
      cardKey,
      chatId: target.chatId,
      threadId: target.threadId,
    })

    const { html, replyMarkup } = formatQuestionCard({
      questions,
      currentIdx: 0,
      selectedMap: {},
      sessionLabel: target.sessionLabel,
      showSession: !target.bound,
      shortId,
    })

    const sent = await this._sendWithThreadFallback(target, (tid) =>
      this.tg.sendMessage(target.chatId, html, {
        threadId: tid,
        replyMarkup,
      })
    )

    const card = {
      connectionId,
      questionId,
      chatId: target.chatId,
      threadId: target.threadId,
      messageId: sent?.message_id || null,
      questions,
      currentIdx: 0,
      selectedMap: {},
      shortId,
      sessionLabel: target.sessionLabel,
      showSession: !target.bound,
      baseHtml: html,
    }
    this.questionCards.set(cardKey, card)
    if (sent?.message_id) {
      this.pendingQuestionReplyByMsgId.set(
        this._replyKey(card.chatId, card.threadId, sent.message_id),
        cardKey
      )
    }
  }

  async _advanceOrSubmitQuestion(card) {
    const cardKey = `${card.connectionId}:${card.questionId}`
    if (card.currentIdx + 1 < card.questions.length) {
      card.currentIdx += 1
      const { html, replyMarkup } = formatQuestionCard({
        questions: card.questions,
        currentIdx: card.currentIdx,
        selectedMap: card.selectedMap,
        sessionLabel: card.sessionLabel,
        showSession: Boolean(card.showSession),
        shortId: card.shortId,
      })
      card.baseHtml = html
      if (card.messageId) {
        await this.tg.editMessageText(card.chatId, card.messageId, html, {
          replyMarkup,
        })
      }
      return
    }

    const answers = card.questions.map((q) => ({
      questionId: q.id,
      labels: card.selectedMap[q.id] || [],
    }))
    await this.codeg.acpAnswerQuestion({
      connectionId: card.connectionId,
      questionId: card.questionId,
      answer: { answers, declined: false },
    })

    const summary = answers
      .map((a) => escapeHtml((a.labels || []).join(", ") || "(空)"))
      .join(" · ")
    await this._markCardResolved(
      card.chatId,
      card.messageId,
      card.baseHtml,
      `<i>✓ 已提交 · ${summary}</i>`
    )
    this.questionCards.delete(cardKey)
    if (card.messageId) {
      this.pendingQuestionReplyByMsgId.delete(
        this._replyKey(card.chatId, card.threadId, card.messageId)
      )
    }
    this.state.deleteCallback(card.shortId)
  }

  async _handleQuestionResolved(connectionId, envelope) {
    const cardKey = `${connectionId}:${envelope.question_id}`
    const card = this.questionCards.get(cardKey)
    if (!card) return
    this.questionCards.delete(cardKey)
    if (card.messageId) {
      this.pendingQuestionReplyByMsgId.delete(
        this._replyKey(card.chatId, card.threadId, card.messageId)
      )
    }
    this.state.deleteCallback(card.shortId)
    await this._markCardResolved(
      card.chatId,
      card.messageId,
      card.baseHtml,
      "<i>✓ 已处理</i>"
    )
  }

  async _surfacePlanApprovalRequest(connectionId, payload) {
    const approvalId = payload?.approval_id
    if (!approvalId) return
    const cardKey = `${connectionId}:${approvalId}`
    if (this.planCards.has(cardKey)) return

    const target = await this._resolveTargetForConnection(connectionId)
    if (!target) return

    const planMarkdown = payload.plan_markdown || ""
    if (planMarkdown.length > 2600) {
      await this._sendWithThreadFallback(target, (tid) =>
        this.tg.sendDocument(target.chatId, "plan.md", planMarkdown, {
          threadId: tid,
        })
      )
    }

    const shortId = this.state.registerCallback("plan", {
      cardKey,
      chatId: target.chatId,
      threadId: target.threadId,
    })
    const { html, replyMarkup } = formatPlanApprovalCard({
      planMarkdown,
      sessionLabel: target.sessionLabel,
      showSession: !target.bound,
      shortId,
    })

    const sent = await this._sendWithThreadFallback(target, (tid) =>
      this.tg.sendMessage(target.chatId, html, {
        threadId: tid,
        replyMarkup,
      })
    )

    this.planCards.set(cardKey, {
      connectionId,
      approvalId,
      chatId: target.chatId,
      threadId: target.threadId,
      messageId: sent?.message_id || null,
      planMarkdown,
      shortId,
      baseHtml: html,
    })
  }

  async _handlePlanApprovalResolved(connectionId, envelope) {
    const cardKey = `${connectionId}:${envelope.approval_id}`
    const card = this.planCards.get(cardKey)
    if (!card) return
    this.planCards.delete(cardKey)
    if (card.messageId) {
      this.pendingPlanFeedbackByMsgId.delete(
        this._replyKey(card.chatId, card.threadId, card.messageId)
      )
    }
    this.state.deleteCallback(card.shortId)
    await this._markCardResolved(
      card.chatId,
      card.messageId,
      card.baseHtml,
      "<i>✓ 已处理</i>"
    )
  }

  async _markCardResolved(chatId, messageId, baseHtml, statusLine) {
    if (!messageId) return
    const nextHtml = `${baseHtml}\n\n${statusLine}`
    await this.tg.editMessageText(chatId, messageId, nextHtml, {
      replyMarkup: { inline_keyboard: [] },
    })
  }

  /**
   * A button pressed from a chat that does not own it: refuse loudly, change nothing.
   * The card stays pending so its real owner can still answer.
   */
  async _rejectForeignCallback(cq, label) {
    this.logger.warn(
      `[auth] refused ${label} callback from a chat that does not own it`
    )
    await this.tg
      .answerCallbackQuery(cq.id, {
        text: `该${label}卡片不属于当前聊天，已拒绝`,
        showAlert: true,
      })
      .catch(() => {})
  }

  async _handleCallbackQuery(cq) {
    const userId = cq?.from?.id
    if (!userId || !this._isAuthorized(userId)) {
      this.logger.warn(
        `[auth] rejected unauthorized callback from user=${userId}`
      )
      return
    }

    const data = String(cq.data || "")
    const msg = cq.message
    const chatId = msg?.chat?.id || userId
    const threadId = Number.isInteger(msg?.message_thread_id)
      ? msg.message_thread_id
      : 0
    const messageId = msg?.message_id || null

    const parts = data.split(":")
    const prefix = parts[0]
    const shortId = parts[1]

    try {
      switch (prefix) {
        case "perm": {
          const optIdx = Number.parseInt(parts[2], 10)
          const entry = this.state.getCallback(shortId)
          if (!entry) {
            await this.tg.answerCallbackQuery(cq.id, {
              text: "该审批请求已过期或已处理",
              showAlert: true,
            })
            return
          }
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "审批")
            return
          }
          const opt = entry.data.options?.[optIdx]
          if (!opt) {
            await this.tg.answerCallbackQuery(cq.id, { text: "无效的审批选项" })
            return
          }
          await this.codeg.acpRespondPermission({
            connectionId: entry.data.connectionId,
            requestId: entry.data.requestId,
            optionId: opt.option_id,
          })
          await this.tg.answerCallbackQuery(cq.id, {
            text: `已选择：${opt.name}`,
          })
          const card = this.permissionCards.get(entry.data.cardKey)
          if (card) {
            this.permissionCards.delete(entry.data.cardKey)
            await this._markCardResolved(
              card.chatId,
              card.messageId,
              card.baseHtml,
              `<i>✓ 已允许 · ${escapeHtml(opt.name)}</i>`
            )
          }
          this.state.deleteCallback(shortId)
          return
        }

        case "qopt": {
          const qIdx = Number.parseInt(parts[2], 10)
          const optIdx = Number.parseInt(parts[3], 10)
          const entry = this.state.getCallback(shortId)
          const card = entry ? this.questionCards.get(entry.data.cardKey) : null
          if (!card) {
            await this.tg.answerCallbackQuery(cq.id, {
              text: "该提问已过期或已回答",
            })
            return
          }
          if (
            !this._ownsCallback(entry, chatId, threadId) ||
            !this._ownsCard(card, chatId, threadId)
          ) {
            await this._rejectForeignCallback(cq, "提问")
            return
          }
          const q = card.questions[qIdx]
          const opt = q?.options?.[optIdx]
          if (!q || !opt) return

          if (q.multi_select) {
            const cur = Array.isArray(card.selectedMap[q.id])
              ? [...card.selectedMap[q.id]]
              : []
            const pos = cur.indexOf(opt.label)
            if (pos >= 0) cur.splice(pos, 1)
            else cur.push(opt.label)
            card.selectedMap[q.id] = cur

            const { html, replyMarkup } = formatQuestionCard({
              questions: card.questions,
              currentIdx: qIdx,
              selectedMap: card.selectedMap,
              sessionLabel: card.sessionLabel,
              showSession: Boolean(card.showSession),
              shortId,
            })
            card.baseHtml = html
            if (card.messageId) {
              await this.tg.editMessageText(card.chatId, card.messageId, html, {
                replyMarkup,
              })
            }
            await this.tg.answerCallbackQuery(cq.id, {
              text: `已选 ${cur.length} 项`,
            })
          } else {
            card.selectedMap[q.id] = [opt.label]
            card.currentIdx = qIdx
            await this.tg.answerCallbackQuery(cq.id, {
              text: `已选择：${opt.label}`,
            })
            await this._advanceOrSubmitQuestion(card, chatId, threadId)
          }
          return
        }

        case "qsub": {
          const entry = this.state.getCallback(shortId)
          const card = entry ? this.questionCards.get(entry.data.cardKey) : null
          if (!card) {
            await this.tg.answerCallbackQuery(cq.id, { text: "该提问已过期" })
            return
          }
          if (
            !this._ownsCallback(entry, chatId, threadId) ||
            !this._ownsCard(card, chatId, threadId)
          ) {
            await this._rejectForeignCallback(cq, "提问")
            return
          }
          await this.tg.answerCallbackQuery(cq.id, { text: "已提交" })
          await this._advanceOrSubmitQuestion(card, chatId, threadId)
          return
        }

        case "qskip": {
          const entry = this.state.getCallback(shortId)
          const card = entry ? this.questionCards.get(entry.data.cardKey) : null
          if (!card) {
            await this.tg.answerCallbackQuery(cq.id, { text: "该提问已过期" })
            return
          }
          if (
            !this._ownsCallback(entry, chatId, threadId) ||
            !this._ownsCard(card, chatId, threadId)
          ) {
            await this._rejectForeignCallback(cq, "提问")
            return
          }
          await this.codeg.acpAnswerQuestion({
            connectionId: card.connectionId,
            questionId: card.questionId,
            answer: { answers: [], declined: true },
          })
          await this.tg.answerCallbackQuery(cq.id, { text: "已跳过" })
          await this._markCardResolved(
            card.chatId,
            card.messageId,
            card.baseHtml,
            "<i>已跳过</i>"
          )
          this.questionCards.delete(entry.data.cardKey)
          if (card.messageId) {
            this.pendingQuestionReplyByMsgId.delete(
              this._replyKey(card.chatId, card.threadId, card.messageId)
            )
          }
          this.state.deleteCallback(shortId)
          return
        }

        case "plan": {
          const action = parts[2]
          const entry = this.state.getCallback(shortId)
          const card = entry ? this.planCards.get(entry.data.cardKey) : null
          if (!card) {
            await this.tg.answerCallbackQuery(cq.id, {
              text: "该计划已处理或过期",
            })
            return
          }
          if (
            !this._ownsCallback(entry, chatId, threadId) ||
            !this._ownsCard(card, chatId, threadId)
          ) {
            await this._rejectForeignCallback(cq, "计划")
            return
          }
          if (action === "changes") {
            if (card.messageId) {
              this.pendingPlanFeedbackByMsgId.set(
                this._replyKey(card.chatId, card.threadId, card.messageId),
                entry.data.cardKey
              )
            }
            await this.tg.answerCallbackQuery(cq.id, {
              text: "请回复计划消息输入修改要求",
            })
            await this.tg.sendMessage(
              card.chatId,
              "<i>请直接回复上面的计划卡片输入修改意见</i>",
              {
                threadId: card.threadId,
                replyToMessageId: card.messageId || undefined,
              }
            )
            return
          }

          const decision = action === "approve" ? "approve" : "abandon"
          await this.codeg.acpAnswerPlanApproval({
            connectionId: card.connectionId,
            approvalId: card.approvalId,
            answer: { decision, feedback: null },
          })
          const label =
            decision === "approve"
              ? "<i>✓ 已批准执行</i>"
              : "<i>✕ 已放弃计划</i>"
          await this.tg.answerCallbackQuery(cq.id, {
            text: decision === "approve" ? "已批准" : "已放弃",
          })
          await this._markCardResolved(
            card.chatId,
            card.messageId,
            card.baseHtml,
            label
          )
          this.planCards.delete(entry.data.cardKey)
          this.state.deleteCallback(shortId)
          return
        }

        case "newfp": {
          const entry = this.state.getCallback(shortId)
          if (!entry) return
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "新建会话")
            return
          }
          await this.tg.answerCallbackQuery(cq.id)
          await this._cmdNew(chatId, threadId, entry.data.page, messageId)
          return
        }

        case "newf": {
          const entry = this.state.getCallback(shortId)
          if (!entry) {
            await this.tg.answerCallbackQuery(cq.id, {
              text: "菜单已过期，请重发 /new",
            })
            return
          }
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "新建会话")
            return
          }
          const agents = await this.codeg.acpListAgents()
          const available = (agents || []).filter(
            (a) => a.enabled && a.available
          )
          const list =
            available.length > 0
              ? available
              : (agents || []).filter((a) => a.enabled)
          if (list.length === 0) {
            await this.tg.answerCallbackQuery(cq.id, {
              text: "没有可用的 Agent",
              showAlert: true,
            })
            return
          }
          const defAgent = entry.data.defaultAgentType
          list.sort((a, b) =>
            a.agent_type === defAgent ? -1 : b.agent_type === defAgent ? 1 : 0
          )

          const keyboard = []
          let row = []
          for (const a of list) {
            const star = a.agent_type === defAgent ? "★ " : ""
            const aSid = this.state.registerCallback("new_agent", {
              ...entry.data,
              agentType: a.agent_type,
            })
            row.push({
              text: `${star}${truncateText(formatAgentBadge(a.agent_type), 16)}`,
              callback_data: `newa:${aSid}`,
            })
            if (row.length === 2) {
              keyboard.push(row)
              row = []
            }
          }
          if (row.length > 0) keyboard.push(row)

          const backSid = this.state.registerCallback("new_folder_page", {
            page: 0,
            chatId,
            threadId,
          })
          keyboard.push([{ text: "← 返回", callback_data: `newfp:${backSid}` }])

          await this.tg.answerCallbackQuery(cq.id)
          await this.tg.editMessageText(
            chatId,
            messageId,
            `<b>新建会话</b> · <b>${escapeHtml(entry.data.folderName)}</b>\n选择 Agent：`,
            { replyMarkup: { inline_keyboard: keyboard } }
          )
          return
        }

        case "newa": {
          const entry = this.state.getCallback(shortId)
          if (!entry) {
            await this.tg.answerCallbackQuery(cq.id, {
              text: "菜单已过期，请重发 /new",
            })
            return
          }
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "新建会话")
            return
          }
          const {
            folderId,
            folderName,
            workingDir,
            agentType,
            targetThreadId,
          } = entry.data
          await this.tg.answerCallbackQuery(cq.id, { text: "正在启动会话…" })

          const conversationId = await this.codeg.createConversation({
            folderId,
            agentType,
            title: null,
          })

          const agentName = formatAgentBadge(agentType)
          const topicName = `${folderName} · ${agentName}`
          let boundThreadId = targetThreadId > 0 ? targetThreadId : 0
          if (!boundThreadId) {
            boundThreadId = await this._createSessionTopic(chatId, topicName)
          }

          const binding = this.state.bindThread({
            threadId: boundThreadId,
            chatId,
            conversationId,
            folderId,
            folderName,
            workingDir,
            agentType,
            title: topicName,
          })

          const connectionId = await this.codeg.acpConnect({
            agentType,
            workingDir,
            sessionId: null,
          })
          this.state.updateThread(binding.chatId, binding.threadId, {
            connectionId,
          })
          this.connMeta.set(connectionId, {
            conversationId,
            folderId,
            folderName,
            agentType,
          })
          this.codeg.attach(connectionId)

          if (binding.threadId > 0) {
            const readyHtml = `<b>${escapeHtml(topicName)}</b>\n<i>已就绪，发消息或截图即可开始。</i>`
            await this.tg.sendMessage(chatId, readyHtml, {
              threadId: binding.threadId,
            })
            if (messageId) {
              const link = this.botUsername
                ? ` · <a href="https://t.me/${this.botUsername}/${binding.threadId}">进入话题</a>`
                : ""
              await this.tg.editMessageText(
                chatId,
                messageId,
                `✓ 已新建 <b>${escapeHtml(topicName)}</b>${link}`,
                { replyMarkup: { inline_keyboard: [] } }
              )
            }
          } else if (messageId) {
            await this.tg.editMessageText(
              chatId,
              messageId,
              `✓ 已切换到 <b>${escapeHtml(topicName)}</b>\n<i>直接发消息或截图即可开始。</i>`,
              { replyMarkup: { inline_keyboard: [] } }
            )
          } else {
            await this.tg.sendMessage(
              chatId,
              `✓ 已切换到 <b>${escapeHtml(topicName)}</b>\n<i>直接发消息或截图即可开始。</i>`,
              { threadId: 0 }
            )
          }
          this.state.deleteCallback(shortId)
          return
        }

        case "spg": {
          const entry = this.state.getCallback(shortId)
          if (!entry) return
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "会话列表")
            return
          }
          await this.tg.answerCallbackQuery(cq.id)
          await this._cmdSessions(
            chatId,
            threadId,
            entry.data.search || "",
            entry.data.page || 0,
            messageId
          )
          return
        }

        case "sess": {
          const entry = this.state.getCallback(shortId)
          if (!entry) {
            await this.tg.answerCallbackQuery(cq.id, {
              text: "菜单已过期，请重发 /sessions",
            })
            return
          }
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "会话")
            return
          }
          const convId = entry.data.conversationId
          // A Codeg conversation may only live in one topic. If another chat already
          // holds it, refuse without revealing that chat's topic title or link.
          const existing = this.state.findThreadByConversationId(convId)
          if (existing && Number(existing.chatId) !== Number(chatId)) {
            await this.tg.answerCallbackQuery(cq.id, {
              text: "该会话已绑定在其他聊天的独立话题中",
              showAlert: true,
            })
            return
          }
          if (existing && existing.threadId > 0) {
            await this.tg.answerCallbackQuery(cq.id, {
              text: "该会话已在话题中",
            })
            const linkLine = this.botUsername
              ? `<a href="https://t.me/${this.botUsername}/${existing.threadId}">进入话题</a>`
              : `话题 #${existing.threadId}`
            await this.tg.sendMessage(
              chatId,
              `<b>${escapeHtml(existing.title || existing.folderName)}</b> · ${linkLine}`,
              { threadId }
            )
            return
          }

          await this.tg.answerCallbackQuery(cq.id, { text: "正在切换会话…" })
          const [detail, folders] = await Promise.all([
            this.codeg.getFolderConversation(convId, 1),
            this.codeg.listAllFolderDetails(),
          ])
          const sum = detail?.summary
          if (!sum) {
            await this.tg.sendMessage(chatId, "未找到该会话记录。", {
              threadId,
            })
            return
          }
          const folder = (folders || []).find((f) => f.id === sum.folder_id)
          const folderName =
            folder?.alias || folder?.name || `Folder#${sum.folder_id}`
          const workingDir = sum.origin_cwd || folder?.path || null
          const title = sum.title || folderName
          const agentName = formatAgentBadge(sum.agent_type)
          const topicName = sum.title
            ? `${folderName} · ${sum.title}`
            : `${folderName} · ${agentName}`

          const boundThreadId = await this._createSessionTopic(
            chatId,
            topicName
          )
          const binding = this.state.bindThread({
            threadId: boundThreadId,
            chatId,
            conversationId: convId,
            folderId: sum.folder_id,
            folderName,
            workingDir,
            agentType: sum.agent_type,
            externalId: sum.external_id || null,
            title,
          })

          const foundConn = await this.codeg
            .acpFindConnectionForConversation({
              conversationId: convId,
              sessionId: sum.external_id || null,
              agentType: sum.agent_type,
            })
            .catch(() => null)

          if (foundConn?.connection_id) {
            this.state.updateThread(binding.chatId, binding.threadId, {
              connectionId: foundConn.connection_id,
            })
            this.connMeta.set(foundConn.connection_id, {
              conversationId: convId,
              folderId: sum.folder_id,
              folderName,
              agentType: sum.agent_type,
            })
            this.codeg.attach(foundConn.connection_id)
          }

          const liveTag = foundConn?.connection_id ? "🟢 运行中" : "已就绪"
          const histSid = this.state.registerCallback("quick_history", {
            chatId,
            threadId: binding.threadId,
          })
          const openKeyboard = [
            [{ text: "最近记录", callback_data: `qact:${histSid}` }],
          ]

          if (binding.threadId > 0) {
            const topicWelcome = `<b>${escapeHtml(title)}</b>\n<i>${escapeHtml(folderName)} · ${escapeHtml(agentName)} · ${liveTag}</i>`
            await this.tg.sendMessage(chatId, topicWelcome, {
              threadId: binding.threadId,
              replyMarkup: { inline_keyboard: openKeyboard },
            })
            if (messageId && entry.data.source === "sessions") {
              const link = this.botUsername
                ? ` · <a href="https://t.me/${this.botUsername}/${binding.threadId}">进入话题</a>`
                : ""
              await this.tg.editMessageText(
                chatId,
                messageId,
                `✓ 已打开 <b>${escapeHtml(title)}</b>${link}`,
                { replyMarkup: { inline_keyboard: [] } }
              )
            } else if (binding.threadId !== threadId) {
              const link = this.botUsername
                ? ` · <a href="https://t.me/${this.botUsername}/${binding.threadId}">进入话题</a>`
                : ""
              await this.tg.sendMessage(
                chatId,
                `✓ 已打开 <b>${escapeHtml(title)}</b>${link}`,
                { threadId }
              )
            }
          } else {
            const switchedHtml = `✓ 已切换到 <b>${escapeHtml(title)}</b>\n<i>${escapeHtml(folderName)} · ${escapeHtml(agentName)} · ${liveTag}</i>`
            if (messageId && entry.data.source === "sessions") {
              await this.tg.editMessageText(chatId, messageId, switchedHtml, {
                replyMarkup: { inline_keyboard: openKeyboard },
              })
            } else {
              await this.tg.sendMessage(chatId, switchedHtml, {
                threadId: 0,
                replyMarkup: { inline_keyboard: openKeyboard },
              })
            }
          }
          return
        }

        case "mode": {
          const idx = Number.parseInt(parts[2], 10)
          const entry = this.state.getCallback(shortId)
          const chosen = entry?.data?.modes?.[idx]
          if (!entry || !chosen) {
            await this.tg.answerCallbackQuery(cq.id, { text: "菜单已过期" })
            return
          }
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "权限模式")
            return
          }
          await this.codeg.acpSetMode({
            connectionId: entry.data.connectionId,
            modeId: chosen.id,
          })
          const mState = this.connModes.get(entry.data.connectionId)
          if (mState) mState.current_mode_id = chosen.id
          await this.tg.answerCallbackQuery(cq.id, {
            text: `已切换：${chosen.name || chosen.id}`,
          })
          await this.tg.editMessageText(
            chatId,
            messageId,
            `✓ 权限模式已切换为 <b>${escapeHtml(chosen.name || chosen.id)}</b>`,
            { replyMarkup: { inline_keyboard: [] } }
          )
          this.state.deleteCallback(shortId)
          return
        }

        case "cfgopt": {
          const optIdx = Number.parseInt(parts[2], 10)
          const entry = this.state.getCallback(shortId)
          if (!entry) {
            await this.tg.answerCallbackQuery(cq.id, { text: "菜单已过期" })
            return
          }
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "模型设置")
            return
          }
          await this.tg.answerCallbackQuery(cq.id)
          await this._renderConfigOptionMenu(
            chatId,
            threadId,
            shortId,
            optIdx,
            messageId
          )
          return
        }

        case "cfgval": {
          const optIdx = Number.parseInt(parts[2], 10)
          const valIdx = Number.parseInt(parts[3], 10)
          const entry = this.state.getCallback(shortId)
          const opt = entry?.data?.options?.[optIdx]
          const val = opt?.values?.[valIdx]
          if (!entry || !opt || !val) {
            await this.tg.answerCallbackQuery(cq.id, { text: "菜单已过期" })
            return
          }
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "模型设置")
            return
          }
          await this.codeg.acpSetConfigOption({
            connectionId: entry.data.connectionId,
            configId: opt.id,
            valueId: val.value,
          })
          opt.current_value = val.value
          await this.tg.answerCallbackQuery(cq.id, {
            text: `已切换：${val.name}`,
          })
          await this.tg.editMessageText(
            chatId,
            messageId,
            `✓ <b>${escapeHtml(opt.name)}</b>已切换为 <b>${escapeHtml(val.name)}</b>`,
            { replyMarkup: { inline_keyboard: [] } }
          )
          this.state.deleteCallback(shortId)
          return
        }

        case "cls": {
          const action = parts[2]
          const entry = this.state.getCallback(shortId)
          if (!entry) {
            await this.tg.answerCallbackQuery(cq.id, { text: "操作已过期" })
            return
          }
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "关闭会话")
            return
          }
          if (action === "cancel") {
            await this.tg.answerCallbackQuery(cq.id, { text: "已取消" })
            await this.tg.editMessageText(chatId, messageId, "已取消。", {
              replyMarkup: { inline_keyboard: [] },
            })
            this.state.deleteCallback(shortId)
            return
          }
          const {
            threadId: targetTid,
            conversationId,
            connectionId,
          } = entry.data
          if (connectionId) {
            this.codeg.detach(connectionId)
            await this.codeg.acpDisconnect(connectionId).catch(() => {})
          }
          if (action === "delete" && conversationId) {
            await this.codeg
              .deleteConversation({ conversationId })
              .catch(() => {})
          }
          this.state.unbindThread(chatId, targetTid)
          await this.tg.answerCallbackQuery(cq.id, { text: "已关闭" })
          await this.tg.editMessageText(
            chatId,
            messageId,
            action === "delete"
              ? "✓ 已关闭并删除会话。"
              : "✓ 已解除当前会话绑定。",
            { replyMarkup: { inline_keyboard: [] } }
          )
          if (targetTid > 0) {
            await this.tg.closeForumTopic(chatId, targetTid).catch(() => {})
          }
          this.state.deleteCallback(shortId)
          return
        }

        case "stop": {
          const entry = this.state.getCallback(shortId)
          if (!entry) return
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "中止")
            return
          }
          await this.codeg.acpCancel(entry.data.connectionId)
          await this.tg.answerCallbackQuery(cq.id, { text: "已中止" })
          await this.tg.editMessageReplyMarkup(chatId, messageId, {
            inline_keyboard: [],
          })
          this.state.deleteCallback(shortId)
          return
        }

        case "qact": {
          const entry = this.state.getCallback(shortId)
          if (!entry) return
          if (!this._ownsCallback(entry, chatId, threadId)) {
            await this._rejectForeignCallback(cq, "菜单")
            return
          }
          await this.tg.answerCallbackQuery(cq.id)
          if (entry.kind === "quick_new") {
            await this._cmdNew(chatId, threadId, 0, messageId)
          } else if (entry.kind === "quick_mode") {
            await this._cmdMode(chatId, threadId, messageId)
          } else if (entry.kind === "quick_model") {
            await this._cmdModel(chatId, threadId, messageId)
          } else if (entry.kind === "quick_history") {
            await this._cmdHistory(chatId, threadId, "4")
          } else {
            await this._cmdSessions(chatId, threadId, "", 0, messageId)
          }
          return
        }

        case "web": {
          const action = parts[1]
          if (action === "revoke") {
            const kicked = this.webappProxy?.revokeAllSessions() ?? 0
            await this.tg.answerCallbackQuery(cq.id, {
              text: `已注销 ${kicked} 个网页会话`,
            })
            await this._cmdWeb(chatId, threadId, messageId)
          } else if (action === "stop") {
            this.webappProxy?.revokeAllSessions()
            this.tunnel?.stop()
            this.miniAppUrl = ""
            await this._syncMenuButton("").catch(() => {})
            await this.tg.answerCallbackQuery(cq.id, {
              text: "已关闭公网手机入口",
            })
            await this._cmdWeb(chatId, threadId, messageId)
          } else if (action === "start") {
            this.tunnel?.start()
            await this.tg.answerCallbackQuery(cq.id, { text: "正在开启隧道…" })
            await this._cmdWeb(chatId, threadId, messageId)
          } else if (action === "rotate") {
            this.webappProxy?.revokeAllSessions()
            this.miniAppUrl = ""
            await this.tunnel?.rotate()
            await this.tg.answerCallbackQuery(cq.id, {
              text: "已更换隧道地址并踢出旧会话",
            })
            await this._cmdWeb(chatId, threadId, messageId)
          } else {
            await this.tg.answerCallbackQuery(cq.id)
          }
          return
        }

        default:
          await this.tg.answerCallbackQuery(cq.id)
      }
    } catch (err) {
      this.logger.error(`[cb] callback ${prefix} failed: ${err.message}`)
      await this.tg
        .answerCallbackQuery(cq.id, {
          text: `操作失败: ${truncateText(redactText(err.message), 80)}`,
          showAlert: true,
        })
        .catch(() => {})
    }
  }
}

function writePidFile(pidFile) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true })
  fs.writeFileSync(pidFile, String(process.pid), "utf8")
}

function removePidFile(pidFile) {
  try {
    if (fs.existsSync(pidFile)) {
      const val = fs.readFileSync(pidFile, "utf8").trim()
      if (val === String(process.pid)) {
        fs.unlinkSync(pidFile)
      }
    }
  } catch {
    // ignore
  }
}

async function main() {
  const cfg = loadConfig()
  const logger = createLogger(cfg.logFile)
  const runDir = path.dirname(cfg.stateFile)
  const pidFile = path.join(runDir, "bot.pid")
  writePidFile(pidFile)

  const tgToken = loadTelegramToken(cfg)
  registerSecret(tgToken)
  const proxyUrl = resolveTelegramProxy(cfg)
  if (proxyUrl) {
    logger.info(
      `[net] Telegram API using explicit proxy ${redactUrl(proxyUrl)}`
    )
  } else {
    logger.info("[net] Telegram API direct (no proxy configured)")
  }

  const tg = new TelegramClient({
    token: tgToken,
    apiBase: cfg.telegramApiBase,
    proxyUrl,
    logger,
  })

  const codeg = new CodegClient({
    baseUrl: cfg.codegUrl,
    tokenProvider: () => {
      const tok = loadCodegToken(cfg)
      if (tok) registerSecret(tok)
      return tok
    },
    logger,
  })

  let webappProxy = null
  let tunnel = null
  if (cfg.miniApp?.enabled) {
    const proxyHost = cfg.miniApp.proxyHost || "127.0.0.1"
    const proxyPort = Number(cfg.miniApp.proxyPort || 3081)
    const ttlHours = Number(cfg.miniApp.sessionTtlHours || 12)
    webappProxy = new WebAppProxy({
      host: proxyHost,
      port: proxyPort,
      upstreamUrl: cfg.codegUrl,
      botToken: tgToken,
      codegTokenProvider: () => loadCodegToken(cfg),
      allowedUserIds: cfg.allowedUserIds || [],
      sessionTtlMs: ttlHours * 3600 * 1000,
      logger,
    })
    if (cfg.miniApp.cloudflaredPath) {
      tunnel = new QuickTunnelManager({
        cloudflaredPath: cfg.miniApp.cloudflaredPath,
        targetUrl: `http://${proxyHost}:${proxyPort}`,
        runDir,
        mode: cfg.miniApp.tunnelMode || "quick",
        tokenFile: cfg.miniApp.tunnelTokenFile || "",
        publicUrl: cfg.miniApp.publicUrl || "",
        logger,
      })
    }
  }

  const state = new StateStore(cfg.stateFile)
  const bot = new CodegTgBot({
    cfg,
    tg,
    codeg,
    state,
    webappProxy,
    tunnel,
    logger,
  })

  const shutdown = (sig) => {
    logger.info(`[bot] received ${sig}, shutting down...`)
    bot.stop()
    removePidFile(pidFile)
    process.exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("exit", () => removePidFile(pidFile))

  await bot.start()
}

const isEntrypoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntrypoint) {
  main().catch((err) => {
    console.error(redactText(`[FATAL] ${err.stack || err.message}`))
    process.exit(1)
  })
}
