// SPDX-License-Identifier: Apache-2.0
import http from "node:http"
import https from "node:https"
import crypto from "node:crypto"
import { EventEmitter } from "node:events"
import { SimpleWebSocket } from "./ws-client.mjs"
import {
  redactText,
  redactError,
  redactUrl,
  registerSecret,
} from "./redact.mjs"

export class CodegApiError extends Error {
  constructor(endpoint, statusCode, code, message, detail = null) {
    super(
      redactText(`Codeg ${endpoint} failed (${statusCode} ${code}): ${message}`)
    )
    this.name = "CodegApiError"
    this.endpoint = endpoint
    this.statusCode = statusCode
    this.code = code || "unknown"
    this.apiMessage = redactText(message)
    this.detail = detail
  }
}

export function isTurnInProgressError(err) {
  return (
    err instanceof CodegApiError &&
    (err.statusCode === 409 ||
      err.code === "turn_in_progress" ||
      /turn.*progress/i.test(err.message))
  )
}

export class CodegClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {() => string} opts.tokenProvider
   * @param {object} [opts.logger]
   */
  constructor({
    baseUrl = "http://127.0.0.1:3080",
    tokenProvider,
    logger = console,
  } = {}) {
    super()
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.tokenProvider = tokenProvider
    this.logger = logger

    this.ws = null
    this.wsIntentionalClose = false
    this.wsReconnectTimer = null
    this.wsPingTimer = null
    this.wsReconnectDelayMs = 1000
    this.wsReady = false

    /** @type {Map<string, { subscriptionId: string, lastSeq: number | null, sentAttach: boolean }>} */
    this.subscriptions = new Map()
  }

  _getToken() {
    const tok = (this.tokenProvider?.() || "").trim()
    if (tok) registerSecret(tok)
    return tok
  }

  _postRaw(endpoint, bodyObj, token, timeoutMs) {
    const urlObj = new URL(`${this.baseUrl}/api/${endpoint}`)
    const isHttps = urlObj.protocol === "https:"
    const transport = isHttps ? https : http
    const payload = JSON.stringify(bodyObj ?? {})
    if (urlObj.username || urlObj.password) {
      registerSecret(decodeURIComponent(urlObj.password || ""))
      registerSecret(decodeURIComponent(urlObj.username || ""))
    }

    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: urlObj.protocol,
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: `${urlObj.pathname}${urlObj.search}`,
          method: "POST",
          headers,
          timeout: timeoutMs,
          agent: false, // always direct, never through HTTP proxy
        },
        (res) => {
          const chunks = []
          res.on("data", (c) => chunks.push(c))
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode || 0,
              bodyText: Buffer.concat(chunks).toString("utf8"),
            })
          })
        }
      )

      req.on("timeout", () => {
        req.destroy(
          new Error(
            redactText(`Codeg API timeout (${timeoutMs}ms) on /api/${endpoint}`)
          )
        )
      })
      req.on("error", (err) => reject(redactError(err)))
      req.write(payload)
      req.end()
    })
  }

  async post(
    endpoint,
    params = {},
    { timeoutMs = 30000, retryAuth = true } = {}
  ) {
    const token = this._getToken()
    const res = await this._postRaw(endpoint, params, token, timeoutMs)

    if (res.statusCode === 401 && retryAuth) {
      const refreshed = this._getToken()
      if (refreshed && refreshed !== token) {
        return this.post(endpoint, params, { timeoutMs, retryAuth: false })
      }
    }

    let parsed = null
    if (res.bodyText.trim()) {
      try {
        parsed = JSON.parse(res.bodyText)
      } catch {
        if (res.statusCode >= 400) {
          throw new CodegApiError(
            endpoint,
            res.statusCode,
            "http_error",
            res.bodyText.slice(0, 300)
          )
        }
        return res.bodyText
      }
    }

    if (res.statusCode >= 400) {
      const code = parsed?.code || `http_${res.statusCode}`
      const message =
        parsed?.message || res.bodyText || `HTTP ${res.statusCode}`
      throw new CodegApiError(
        endpoint,
        res.statusCode,
        code,
        message,
        parsed?.detail ?? null
      )
    }

    return parsed
  }

  // ─── REST API methods (Codeg v0.45.0 camelCase request DTOs) ───

  health() {
    return this.post("health", {}, { timeoutMs: 5000 })
  }

  listOpenFolderDetails() {
    return this.post("list_open_folder_details", {})
  }

  listAllFolderDetails() {
    return this.post("list_all_folder_details", {})
  }

  acpListAgents() {
    return this.post("acp_list_agents", {})
  }

  listAllConversations(params = {}) {
    return this.post("list_all_conversations", params)
  }

  getFolderConversation(conversationId, tailTurns = undefined) {
    const params = { conversationId }
    if (typeof tailTurns === "number") params.tailTurns = tailTurns
    return this.post("get_folder_conversation", params)
  }

  createConversation({ folderId, agentType, title = null }) {
    return this.post("create_conversation", { folderId, agentType, title })
  }

  updateConversationTitle({ conversationId, title }) {
    return this.post("update_conversation_title", { conversationId, title })
  }

  deleteConversation({ conversationId }) {
    return this.post("delete_conversation", { conversationId })
  }

  acpListConnections() {
    return this.post("acp_list_connections", {})
  }

  acpFindConnectionForConversation({
    conversationId,
    sessionId = null,
    agentType,
  }) {
    return this.post("acp_find_connection_for_conversation", {
      conversationId,
      sessionId,
      agentType,
    })
  }

  acpGetSessionSnapshot(connectionId) {
    return this.post("acp_get_session_snapshot", { connectionId })
  }

  acpConnect({
    agentType,
    workingDir = null,
    sessionId = null,
    preferredModeId = null,
    preferredConfigValues = null,
  }) {
    const params = { agentType, workingDir, sessionId }
    if (preferredModeId) params.preferredModeId = preferredModeId
    if (preferredConfigValues)
      params.preferredConfigValues = preferredConfigValues
    return this.post("acp_connect", params, { timeoutMs: 45000 })
  }

  acpDisconnect(connectionId) {
    return this.post("acp_disconnect", { connectionId })
  }

  acpPrompt({
    connectionId,
    blocks,
    folderId = null,
    conversationId = null,
    clientMessageId = null,
  }) {
    return this.post("acp_prompt", {
      connectionId,
      blocks,
      folderId,
      conversationId,
      clientMessageId,
    })
  }

  acpCancel(connectionId) {
    return this.post("acp_cancel", { connectionId })
  }

  acpSetMode({ connectionId, modeId }) {
    return this.post("acp_set_mode", { connectionId, modeId })
  }

  acpSetConfigOption({ connectionId, configId, valueId }) {
    return this.post("acp_set_config_option", {
      connectionId,
      configId,
      valueId,
    })
  }

  acpRespondPermission({ connectionId, requestId, optionId }) {
    return this.post("acp_respond_permission", {
      connectionId,
      requestId,
      optionId,
    })
  }

  acpAnswerQuestion({ connectionId, questionId, answer }) {
    return this.post("acp_answer_question", {
      connectionId,
      questionId,
      answer,
    })
  }

  acpAnswerPlanApproval({ connectionId, approvalId, answer }) {
    return this.post("acp_answer_plan_approval", {
      connectionId,
      approvalId,
      answer,
    })
  }

  listChatChannels() {
    return this.post("list_chat_channels", {})
  }

  // ─── WebSocket (/ws/events) + Attach Protocol ───

  isWsOpen() {
    return Boolean(this.ws && this.ws.readyState === SimpleWebSocket.OPEN)
  }

  _sendWsJson(obj) {
    if (!this.isWsOpen()) return false
    this.ws.send(JSON.stringify(obj))
    return true
  }

  connectWs() {
    this.wsIntentionalClose = false
    if (
      this.ws &&
      (this.ws.readyState === SimpleWebSocket.OPEN ||
        this.ws.readyState === SimpleWebSocket.CONNECTING)
    ) {
      return
    }

    const token = this._getToken()
    if (!token) {
      this.logger.warn?.(
        "[codeg-ws] cannot connect WS without Codeg web_service_token; retrying..."
      )
      this._scheduleWsReconnect()
      return
    }

    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/ws/events`
    const b64Token = Buffer.from(token, "utf8").toString("base64url")
    const protocols = ["codeg-events", `codeg-token.${b64Token}`]

    let socket
    try {
      socket = new SimpleWebSocket(wsUrl, protocols)
    } catch (err) {
      this.logger.warn?.(
        `[codeg-ws] WebSocket constructor error: ${redactText(err.message)}`
      )
      this._scheduleWsReconnect()
      return
    }

    this.ws = socket
    this.wsReady = false

    socket.addEventListener("open", () => {
      if (this.ws !== socket) return
      this.wsReady = true
      this.wsReconnectDelayMs = 1000
      this.logger.info?.(`[codeg-ws] connected to ${redactUrl(wsUrl)}`)

      for (const sub of this.subscriptions.values()) {
        sub.sentAttach = false
      }
      this._flushPendingAttaches()
      this._startWsPing()
      this.emit("ws_open")
    })

    socket.addEventListener("message", (event) => {
      if (this.ws !== socket) return
      let msg
      try {
        msg = JSON.parse(String(event.data))
      } catch (err) {
        this.logger.warn?.(
          `[codeg-ws] malformed WS JSON frame: ${redactText(err.message)}`
        )
        return
      }
      this._handleWsMessage(msg)
    })

    socket.addEventListener("error", (err) => {
      if (this.ws !== socket) return
      this.logger.warn?.(
        `[codeg-ws] socket error: ${redactText(err?.message || "connection failed")}`
      )
    })

    socket.addEventListener("close", (ev) => {
      if (this.ws !== socket) return
      this.ws = null
      this.wsReady = false
      this._stopWsPing()
      for (const sub of this.subscriptions.values()) {
        sub.sentAttach = false
      }
      this.emit("ws_close", { code: ev.code, reason: ev.reason })
      if (!this.wsIntentionalClose) {
        this._scheduleWsReconnect()
      }
    })
  }

  closeWs() {
    this.wsIntentionalClose = true
    this._stopWsPing()
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer)
      this.wsReconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore close errors
      }
      this.ws = null
    }
    this.wsReady = false
  }

  _startWsPing() {
    this._stopWsPing()
    this.wsPingTimer = setInterval(() => {
      this._sendWsJson({ action: "ping" })
    }, 25000)
    this.wsPingTimer.unref?.()
  }

  _stopWsPing() {
    if (this.wsPingTimer) {
      clearInterval(this.wsPingTimer)
      this.wsPingTimer = null
    }
  }

  _scheduleWsReconnect() {
    if (this.wsIntentionalClose || this.wsReconnectTimer) return
    const delay = this.wsReconnectDelayMs
    this.wsReconnectDelayMs = Math.min(
      15000,
      Math.round(this.wsReconnectDelayMs * 1.8)
    )
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null
      this.connectWs()
    }, delay)
    this.wsReconnectTimer.unref?.()
  }

  _flushPendingAttaches() {
    if (!this.isWsOpen()) return
    for (const [connectionId, sub] of this.subscriptions.entries()) {
      if (!sub.sentAttach) {
        sub.sentAttach = true
        this._sendWsJson({
          action: "attach",
          subscription_id: sub.subscriptionId,
          connection_id: connectionId,
          since_seq: sub.lastSeq,
        })
      }
    }
  }

  attach(connectionId, sinceSeq = undefined, { force = false } = {}) {
    if (!connectionId) return null
    let sub = this.subscriptions.get(connectionId)
    if (!sub) {
      sub = {
        subscriptionId: `tg-${crypto.randomBytes(6).toString("hex")}`,
        lastSeq: typeof sinceSeq === "number" ? sinceSeq : null,
        sentAttach: false,
      }
      this.subscriptions.set(connectionId, sub)
    } else if (force) {
      if (typeof sinceSeq === "number" || sinceSeq === null) {
        sub.lastSeq = sinceSeq
      }
      sub.sentAttach = false
    }

    if (this.isWsOpen() && !sub.sentAttach) {
      sub.sentAttach = true
      this._sendWsJson({
        action: "attach",
        subscription_id: sub.subscriptionId,
        connection_id: connectionId,
        since_seq: sub.lastSeq,
      })
    } else if (!this.ws && !this.wsIntentionalClose) {
      this.connectWs()
    }
    return sub.subscriptionId
  }

  detach(connectionId) {
    const sub = this.subscriptions.get(connectionId)
    if (!sub) return
    this.subscriptions.delete(connectionId)
    if (this.isWsOpen()) {
      this._sendWsJson({
        action: "detach",
        subscription_id: sub.subscriptionId,
      })
    }
  }

  isAttached(connectionId) {
    return this.subscriptions.has(connectionId)
  }

  _findConnectionBySubId(subscriptionId) {
    for (const [connId, sub] of this.subscriptions.entries()) {
      if (sub.subscriptionId === subscriptionId) return [connId, sub]
    }
    return [null, null]
  }

  _handleWsMessage(msg) {
    if (!msg || typeof msg !== "object") return

    // Global side-channel frames: { channel, payload }
    if ("channel" in msg) {
      this.emit("global", { channel: msg.channel, payload: msg.payload })
      return
    }

    switch (msg.type) {
      case "pong":
        return

      case "snapshot": {
        const sub = this.subscriptions.get(msg.connection_id)
        if (sub && sub.subscriptionId === msg.subscription_id) {
          if (typeof msg.event_seq === "number") {
            sub.lastSeq = msg.event_seq
          }
        }
        this.emit("snapshot", {
          connectionId: msg.connection_id,
          subscriptionId: msg.subscription_id,
          snapshot: msg.snapshot,
          eventSeq: msg.event_seq,
        })
        return
      }

      case "replay": {
        const sub = this.subscriptions.get(msg.connection_id)
        const events = Array.isArray(msg.events) ? msg.events : []
        for (const envelope of events) {
          if (
            sub &&
            typeof sub.lastSeq === "number" &&
            typeof envelope?.seq === "number" &&
            envelope.seq <= sub.lastSeq
          ) {
            continue
          }
          if (sub && typeof envelope?.seq === "number") {
            sub.lastSeq = envelope.seq
          }
          this.emit("acp", { connectionId: msg.connection_id, envelope })
        }
        if (sub && typeof msg.high_water_seq === "number") {
          sub.lastSeq = Math.max(sub.lastSeq ?? 0, msg.high_water_seq)
        }
        return
      }

      case "event": {
        const envelope = msg.envelope
        const connId =
          envelope?.connection_id ||
          this._findConnectionBySubId(msg.subscription_id)[0]
        if (!connId || !envelope) return
        const sub = this.subscriptions.get(connId)
        if (
          sub &&
          typeof sub.lastSeq === "number" &&
          typeof envelope.seq === "number" &&
          envelope.seq <= sub.lastSeq
        ) {
          return
        }
        if (sub && typeof envelope.seq === "number") {
          sub.lastSeq = envelope.seq
        }
        this.emit("acp", { connectionId: connId, envelope })
        return
      }

      case "detached": {
        const [connId, sub] = this._findConnectionBySubId(msg.subscription_id)
        if (!connId || !sub) return
        sub.sentAttach = false
        this.emit("detached", { connectionId: connId, reason: msg.reason })
        if (msg.reason === "lagged") {
          this.attach(connId, sub.lastSeq, { force: true })
        } else if (msg.reason === "connection_gone") {
          this.subscriptions.delete(connId)
        }
        return
      }

      default:
        return
    }
  }
}
