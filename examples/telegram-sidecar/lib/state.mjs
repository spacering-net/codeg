// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const CALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CALLBACK_MAX_ENTRIES = 2000

/**
 * v2 = topic bindings keyed by `(chatId, threadId)`.
 * v1 (legacy) keyed topics by `threadId` alone with a single global fallback slot,
 * which let two chats that reuse the same threadId overwrite each other.
 */
export const STATE_SCHEMA_VERSION = 2

function createEmptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    migratedAt: null,
    updateOffset: 0,
    primaryChatId: null,
    knownChatIds: [],
    threadedModeSupported: null,
    threadedModeByChat: {},
    threads: {},
    unassignedThreads: [],
    callbacks: {},
  }
}

function toChatId(value) {
  const n = Number(value)
  return Number.isFinite(n) && n !== 0 ? n : null
}

function toThreadId(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Composite identity for a topic binding. threadId 0 is the chat's fallback slot. */
export function threadKey(chatId, threadId) {
  return `${Number(chatId)}:${toThreadId(threadId)}`
}

function normalizeRecord(raw, { chatId, threadId }) {
  return {
    chatId,
    threadId,
    conversationId: raw.conversationId ?? null,
    folderId: raw.folderId ?? null,
    folderName: raw.folderName || "",
    workingDir: raw.workingDir || null,
    agentType: raw.agentType,
    externalId: raw.externalId || null,
    connectionId: raw.connectionId || null,
    title: raw.title || "",
    updatedAt: raw.updatedAt || new Date().toISOString(),
  }
}

export class StateStore {
  constructor(stateFile) {
    this.stateFile = stateFile
    this.data = createEmptyState()
    this.loadError = null
    this._saveTimer = null
    this._load()
  }

  _load() {
    let parsed = null
    try {
      if (!fs.existsSync(this.stateFile)) return
      parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"))
    } catch (err) {
      // A corrupt state file must not silently become a different chat's bindings.
      this.loadError = err
      this.data = createEmptyState()
      return
    }
    if (!parsed || typeof parsed !== "object") {
      this.data = createEmptyState()
      return
    }

    const isLegacy = Number(parsed.schemaVersion || 1) < STATE_SCHEMA_VERSION
    this.data = {
      ...createEmptyState(),
      updateOffset: Number(parsed.updateOffset) || 0,
      primaryChatId: toChatId(parsed.primaryChatId),
      threadedModeSupported:
        typeof parsed.threadedModeSupported === "boolean"
          ? parsed.threadedModeSupported
          : null,
      threadedModeByChat:
        parsed.threadedModeByChat &&
        typeof parsed.threadedModeByChat === "object"
          ? { ...parsed.threadedModeByChat }
          : {},
      callbacks:
        parsed.callbacks && typeof parsed.callbacks === "object"
          ? parsed.callbacks
          : {},
    }

    const known = new Set()
    for (const id of Array.isArray(parsed.knownChatIds)
      ? parsed.knownChatIds
      : []) {
      const c = toChatId(id)
      if (c !== null) known.add(c)
    }
    if (this.data.primaryChatId !== null) known.add(this.data.primaryChatId)

    this.data.threads = {}
    this.data.unassignedThreads = []
    this.data.knownChatIds = [...known]

    if (isLegacy) {
      this._migrateLegacyThreads(parsed)
      this.data.migratedAt = new Date().toISOString()
      this.saveNow()
    } else {
      this._loadV2Threads(parsed)
      for (const rec of Array.isArray(parsed.unassignedThreads)
        ? parsed.unassignedThreads
        : []) {
        if (rec && typeof rec === "object")
          this.data.unassignedThreads.push(rec)
      }
    }

    for (const rec of Object.values(this.data.threads)) {
      if (rec?.chatId !== undefined && rec?.chatId !== null) {
        const c = toChatId(rec.chatId)
        if (c !== null && !this.data.knownChatIds.includes(c))
          this.data.knownChatIds.push(c)
      }
    }
  }

  /** Load records that already carry a composite `chatId:threadId` key. */
  _loadV2Threads(parsed) {
    const threads =
      parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {}
    for (const [key, raw] of Object.entries(threads)) {
      if (!raw || typeof raw !== "object") continue
      const chatId = toChatId(raw.chatId)
      const threadId = toThreadId(raw.threadId)
      if (chatId === null) {
        this._quarantine(
          raw,
          key.includes(":") ? "missing_chat_id" : "legacy_key_without_owner",
          threadId
        )
        continue
      }
      const record = normalizeRecord(raw, { chatId, threadId })
      const expected = threadKey(chatId, threadId)
      if (key !== expected && !this._isLegacyKey(key)) {
        // Key disagrees with its payload: trust the payload, but never drop the record.
        this._quarantine(
          { ...record, originalKey: key },
          "key_mismatch",
          threadId
        )
        continue
      }
      this._putThread(record)
    }
  }

  _isLegacyKey(key) {
    return !String(key).includes(":")
  }

  /**
   * Migrate a v1 file:
   *  - `threads` was keyed by threadId; the owner lived only inside the record.
   *  - `activeFallbackThread` was a single global slot shared by every chat.
   * Records whose owner cannot be established are quarantined in
   * `unassignedThreads` and resolve for no chat at all.
   */
  _migrateLegacyThreads(parsed) {
    const threads =
      parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {}
    for (const [key, raw] of Object.entries(threads)) {
      if (!raw || typeof raw !== "object") continue
      const threadId = toThreadId(raw.threadId ?? key)
      const chatId = toChatId(raw.chatId)
      if (chatId === null) {
        this._quarantine(
          raw,
          raw.chatId === undefined || raw.chatId === null
            ? "missing_chat_id"
            : "invalid_chat_id",
          threadId
        )
        continue
      }
      const record = normalizeRecord(raw, { chatId, threadId })
      const existing = this.data.threads[threadKey(chatId, threadId)]
      if (existing) {
        // Same (chat, thread) twice: keep the newest, quarantine the loser.
        const keepNew = String(record.updatedAt) >= String(existing.updatedAt)
        this._quarantine(
          keepNew ? existing : record,
          "duplicate_binding",
          threadId
        )
        if (keepNew) this._putThread(record)
        continue
      }
      this._putThread(record)
    }

    const fallback = parsed.activeFallbackThread
    if (fallback && typeof fallback === "object") {
      const chatId = toChatId(fallback.chatId)
      if (chatId === null) {
        this._quarantine(
          fallback,
          fallback.chatId === undefined || fallback.chatId === null
            ? "missing_chat_id"
            : "invalid_chat_id",
          0
        )
      } else {
        this._putThread(normalizeRecord(fallback, { chatId, threadId: 0 }))
      }
    }
  }

  _quarantine(raw, reason, threadId = 0) {
    this.data.unassignedThreads.push({
      ...raw,
      threadId,
      unassignedReason: reason,
      unassignedAt: new Date().toISOString(),
    })
  }

  _putThread(record) {
    this.data.threads[threadKey(record.chatId, record.threadId)] = record
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    const dir = path.dirname(this.stateFile)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.stateFile}.${process.pid}.tmp`
    this.data.schemaVersion = STATE_SCHEMA_VERSION
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8")
    fs.renameSync(tmp, this.stateFile)
  }

  scheduleSave(delayMs = 250) {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      try {
        this.saveNow()
      } catch {
        // best-effort background flush
      }
    }, delayMs)
    this._saveTimer.unref?.()
  }

  getUpdateOffset() {
    return this.data.updateOffset || 0
  }

  setUpdateOffset(offset) {
    if (offset > (this.data.updateOffset || 0)) {
      this.data.updateOffset = offset
      this.scheduleSave(400)
    }
  }

  getPrimaryChatId(fallbackUserId = null) {
    return this.data.primaryChatId ?? toChatId(fallbackUserId)
  }

  setPrimaryChatId(chatId) {
    const id = toChatId(chatId)
    if (id === null) return
    if (!this.data.knownChatIds.includes(id)) this.data.knownChatIds.push(id)
    if (this.data.primaryChatId !== id) {
      this.data.primaryChatId = id
      this.saveNow()
    } else {
      this.scheduleSave(400)
    }
  }

  /** Every chat this bot has served; used to refuse ambiguous desktop delivery. */
  getKnownChatIds() {
    return [...this.data.knownChatIds]
  }

  getThreadedModeSupported(chatId = null) {
    if (chatId !== null && chatId !== undefined) {
      const v = this.data.threadedModeByChat[String(chatId)]
      if (typeof v === "boolean") return v
    }
    return this.data.threadedModeSupported
  }

  setThreadedModeSupported(val, chatId = null) {
    let changed = false
    if (chatId !== null && chatId !== undefined) {
      const key = String(chatId)
      if (this.data.threadedModeByChat[key] !== val) {
        this.data.threadedModeByChat[key] = val
        changed = true
      }
    }
    if (this.data.threadedModeSupported !== val) {
      this.data.threadedModeSupported = val
      changed = true
    }
    if (changed) this.saveNow()
  }

  /**
   * @param {{ chatId?: number }} [filter] limit to one chat (recommended)
   */
  listThreads(filter = {}) {
    const chatId =
      filter && typeof filter === "object"
        ? toChatId(filter.chatId)
        : toChatId(filter)
    const out = Object.values(this.data.threads)
    if (chatId === null) return out
    return out.filter((t) => Number(t.chatId) === chatId)
  }

  /** Records that could not be attributed to a chat during migration. */
  listUnassignedThreads() {
    return [...this.data.unassignedThreads]
  }

  /**
   * Look up a binding.
   * @param {number} chatId
   * @param {number} threadId 0 = the chat's fallback session
   */
  getThread(chatId, threadId) {
    if (threadId === undefined) {
      // Legacy single-argument form: only resolves when unambiguous.
      return this._resolveUniqueByThreadId(chatId)
    }
    const c = toChatId(chatId)
    if (c === null) return null
    return this.data.threads[threadKey(c, threadId)] || null
  }

  _resolveUniqueByThreadId(threadId) {
    const t = toThreadId(threadId)
    const matches = Object.values(this.data.threads).filter(
      (rec) => toThreadId(rec.threadId) === t
    )
    return matches.length === 1 ? matches[0] : null
  }

  findThreadByConversationId(conversationId, { chatId = null } = {}) {
    if (conversationId === null || conversationId === undefined) return null
    const scope = toChatId(chatId)
    for (const t of this.listThreads()) {
      if (scope !== null && Number(t.chatId) !== scope) continue
      if (t.conversationId === conversationId) return t
    }
    return null
  }

  findThreadByConnectionId(connectionId, { chatId = null } = {}) {
    if (!connectionId) return null
    const scope = toChatId(chatId)
    for (const t of this.listThreads()) {
      if (scope !== null && Number(t.chatId) !== scope) continue
      if (t.connectionId === connectionId) return t
    }
    return null
  }

  /**
   * Create or replace the binding for `(binding.chatId, binding.threadId)`.
   * `chatId` is mandatory: an ownerless binding is exactly what caused cross-chat
   * overwrites, so it is refused instead of guessed.
   */
  bindThread(binding) {
    const chatId = toChatId(binding?.chatId)
    if (chatId === null) {
      throw new Error("bindThread requires a numeric chatId")
    }
    const record = normalizeRecord(binding, {
      chatId,
      threadId: toThreadId(binding.threadId),
    })
    record.updatedAt = new Date().toISOString()
    this._putThread(record)
    if (!this.data.knownChatIds.includes(chatId))
      this.data.knownChatIds.push(chatId)
    this.saveNow()
    return record
  }

  /**
   * updateThread(chatId, threadId, patch)
   * Legacy: updateThread(threadId, patch) resolves only when unambiguous.
   */
  updateThread(chatId, threadId, patch) {
    let target
    if (patch === undefined) {
      target = this._resolveUniqueByThreadId(chatId)
      patch = threadId
    } else {
      target = this.getThread(chatId, threadId)
    }
    if (!target || !patch || typeof patch !== "object") return null
    Object.assign(target, patch, { updatedAt: new Date().toISOString() })
    this.saveNow()
    return target
  }

  updateThreadByConversationId(conversationId, patch, { chatId = null } = {}) {
    const target = this.findThreadByConversationId(conversationId, { chatId })
    if (!target) return null
    Object.assign(target, patch, { updatedAt: new Date().toISOString() })
    this.saveNow()
    return target
  }

  /**
   * unbindThread(chatId, threadId)
   * Legacy: unbindThread(threadId) resolves only when unambiguous.
   */
  unbindThread(chatId, threadId) {
    let key
    let prev = null
    if (threadId === undefined) {
      const target = this._resolveUniqueByThreadId(chatId)
      if (!target) return null
      key = threadKey(target.chatId, target.threadId)
    } else {
      const c = toChatId(chatId)
      if (c === null) return null
      key = threadKey(c, threadId)
    }
    prev = this.data.threads[key] || null
    if (prev) {
      delete this.data.threads[key]
      this.saveNow()
    }
    return prev
  }

  _pruneCallbacks() {
    const now = Date.now()
    const entries = Object.entries(this.data.callbacks || {})
    const valid = entries.filter(
      ([, item]) => item && now - (item.createdAt || 0) < CALLBACK_TTL_MS
    )
    if (valid.length > CALLBACK_MAX_ENTRIES) {
      valid.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))
      valid.splice(0, valid.length - CALLBACK_MAX_ENTRIES)
    }
    this.data.callbacks = Object.fromEntries(valid)
  }

  /**
   * Persist a short callback id.
   * `data.chatId` / `data.threadId` record which chat and topic the button belongs
   * to; handlers refuse a callback presented from any other chat.
   */
  registerCallback(kind, data) {
    this._pruneCallbacks()
    let id
    do {
      id = crypto.randomBytes(4).toString("hex")
    } while (this.data.callbacks[id])

    const payload = { ...(data || {}) }
    if (payload.chatId !== undefined && payload.chatId !== null) {
      payload.chatId = toChatId(payload.chatId)
    }
    if (payload.threadId !== undefined && payload.threadId !== null) {
      payload.threadId = toThreadId(payload.threadId)
    }

    this.data.callbacks[id] = {
      kind,
      data: payload,
      createdAt: Date.now(),
    }
    this.scheduleSave(300)
    return id
  }

  getCallback(shortId) {
    return this.data.callbacks[shortId] || null
  }

  updateCallback(shortId, data) {
    if (!this.data.callbacks[shortId]) return null
    this.data.callbacks[shortId].data = data
    this.scheduleSave(300)
    return this.data.callbacks[shortId]
  }

  deleteCallback(shortId) {
    if (this.data.callbacks[shortId]) {
      delete this.data.callbacks[shortId]
      this.scheduleSave(300)
    }
  }
}
