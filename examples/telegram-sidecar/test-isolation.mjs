// SPDX-License-Identifier: Apache-2.0
// Chat isolation regression tests: (chatId, threadId) binding identity, per-chat
// fallback sessions, legacy state migration, and cross-chat answer/button rejection.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { StateStore, STATE_SCHEMA_VERSION } from "./lib/state.mjs"
import { CodegTgBot } from "./bot.mjs"

const CHAT_A = 101
const CHAT_B = 202
const THREAD = 1

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codeg-tg-iso-"))
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} }
}

// Minimal Telegram + Codeg doubles. Everything stays local; no network, no secrets.
function makeHarness({ allowedUserIds = [CHAT_A, CHAT_B], state } = {}) {
  const calls = { tg: [], codeg: [] }
  let msgSeq = 5000
  let topicSeq = 700
  let connSeq = 0
  const liveConnections = []

  const tg = {
    async sendMessage(chatId, text, opts = {}) {
      msgSeq += 1
      const result = {
        message_id: msgSeq,
        chat: { id: chatId },
        message_thread_id: opts.threadId,
      }
      calls.tg.push({ method: "sendMessage", chatId, text, opts, result })
      return result
    },
    async editMessageText(chatId, messageId, text, opts = {}) {
      calls.tg.push({
        method: "editMessageText",
        chatId,
        messageId,
        text,
        opts,
      })
      return { message_id: messageId, chat: { id: chatId }, text }
    },
    async editMessageReplyMarkup(chatId, messageId, markup) {
      calls.tg.push({
        method: "editMessageReplyMarkup",
        chatId,
        messageId,
        markup,
      })
      return true
    },
    async answerCallbackQuery(id, opts = {}) {
      calls.tg.push({ method: "answerCallbackQuery", id, opts })
      return true
    },
    async sendChatAction() {
      return null
    },
    async sendDocument(chatId, filename, data, opts = {}) {
      calls.tg.push({ method: "sendDocument", chatId, filename, data, opts })
      msgSeq += 1
      return { message_id: msgSeq, chat: { id: chatId } }
    },
    async createForumTopic(chatId, name) {
      topicSeq += 1
      calls.tg.push({
        method: "createForumTopic",
        chatId,
        name,
        threadId: topicSeq,
      })
      return { message_thread_id: topicSeq, name }
    },
    async editForumTopic() {
      return true
    },
    async closeForumTopic() {
      return true
    },
    async deleteForumTopic() {
      return true
    },
    async setChatMenuButton() {
      return true
    },
    async getMe() {
      return { id: 1, is_bot: true, username: "isolation_test_bot" }
    },
    async setMyCommands() {
      return true
    },
    async getFile() {
      return { file_path: "photos/x.jpg" }
    },
    async downloadFile() {
      return Buffer.alloc(0)
    },
  }

  const record = (name) => async (args) => {
    calls.codeg.push({ method: name, args })
    return null
  }

  const codeg = {
    on() {},
    attach() {},
    detach() {},
    isAttached() {
      return false
    },
    connectWs() {},
    closeWs() {},
    health: record("health"),
    listChatChannels: record("listChatChannels"),
    listOpenFolderDetails: record("listOpenFolderDetails"),
    listAllFolderDetails: record("listAllFolderDetails"),
    listAllConversations: record("listAllConversations"),
    acpListAgents: record("acpListAgents"),
    acpListConnections: async () => {
      calls.codeg.push({ method: "acpListConnections", args: {} })
      return liveConnections.map((id) => ({
        id,
        agent_type: "codex",
        status: "connected",
      }))
    },
    acpGetSessionSnapshot: record("acpGetSessionSnapshot"),
    acpFindConnectionForConversation: record(
      "acpFindConnectionForConversation"
    ),
    acpConnect: async (args) => {
      calls.codeg.push({ method: "acpConnect", args })
      const id = `conn-new-${++connSeq}`
      liveConnections.push(id)
      return id
    },
    acpDisconnect: record("acpDisconnect"),
    acpPrompt: record("acpPrompt"),
    acpCancel: record("acpCancel"),
    acpSetMode: record("acpSetMode"),
    acpSetConfigOption: record("acpSetConfigOption"),
    acpRespondPermission: record("acpRespondPermission"),
    acpAnswerQuestion: record("acpAnswerQuestion"),
    acpAnswerPlanApproval: record("acpAnswerPlanApproval"),
    getFolderConversation: record("getFolderConversation"),
    createConversation: record("createConversation"),
    updateConversationTitle: record("updateConversationTitle"),
    deleteConversation: record("deleteConversation"),
  }

  const cfg = {
    allowedUserIds,
    streamThrottleMs: 10,
    maxMessageChars: 3800,
    proactiveWatchDesktop: false,
  }

  const bot = new CodegTgBot({ cfg, tg, codeg, state, logger: quietLogger() })
  return { bot, tg, codeg, calls }
}

function codegCall(calls, method) {
  return calls.codeg.find((c) => c.method === method)
}

function questionCard(overrides = {}) {
  return {
    connectionId: "connection-chat-101",
    questionId: "question-101",
    chatId: CHAT_A,
    threadId: THREAD,
    messageId: 5,
    questions: [
      {
        id: "q1",
        header: "方式",
        question: "选择实现方案",
        multi_select: false,
        options: [],
      },
    ],
    currentIdx: 0,
    selectedMap: {},
    shortId: "testshort",
    sessionLabel: "Chat A · Codex",
    showSession: false,
    baseHtml: "<b>需要确认</b>",
    ...overrides,
  }
}

function planCard(overrides = {}) {
  return {
    connectionId: "connection-chat-101",
    approvalId: "plan-101",
    chatId: CHAT_A,
    threadId: THREAD,
    messageId: 7,
    planMarkdown: "1. edit a.js",
    shortId: "planshort",
    baseHtml: "<b>执行计划确认</b>",
    ...overrides,
  }
}

// ──────────────────────────────────────────────────────────
// StateStore identity
// ──────────────────────────────────────────────────────────

test("state: topic bindings are keyed by (chatId, threadId) and never overwrite another chat", () => {
  const dir = tmpDir()
  try {
    const state = new StateStore(path.join(dir, "state.json"))
    state.bindThread({
      chatId: CHAT_A,
      threadId: THREAD,
      conversationId: 11,
      agentType: "codex",
    })
    state.bindThread({
      chatId: CHAT_B,
      threadId: THREAD,
      conversationId: 22,
      agentType: "codex",
    })

    assert.equal(
      state.listThreads().length,
      2,
      "both chats keep their own binding"
    )
    assert.equal(state.getThread(CHAT_A, THREAD).conversationId, 11)
    assert.equal(state.getThread(CHAT_B, THREAD).conversationId, 22)

    // Cross-chat lookups must not resolve to the other chat's record.
    assert.equal(state.getThread(303, THREAD), null)
    assert.equal(state.getThread(CHAT_A, 2), null)

    // Conversation/connection lookups stay chat-scoped when a chat is supplied.
    assert.equal(
      state.findThreadByConversationId(11, { chatId: CHAT_A }).chatId,
      CHAT_A
    )
    assert.equal(state.findThreadByConversationId(11, { chatId: CHAT_B }), null)

    state.updateThread(CHAT_B, THREAD, { title: "B only" })
    assert.equal(state.getThread(CHAT_A, THREAD).title, "")
    assert.equal(state.getThread(CHAT_B, THREAD).title, "B only")

    state.unbindThread(CHAT_A, THREAD)
    assert.equal(state.getThread(CHAT_A, THREAD), null)
    assert.equal(
      state.getThread(CHAT_B, THREAD).conversationId,
      22,
      "unbinding one chat leaves the other intact"
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("state: fallback session is per chat, not a single global slot", () => {
  const dir = tmpDir()
  try {
    const state = new StateStore(path.join(dir, "state.json"))
    state.bindThread({
      chatId: CHAT_A,
      threadId: 0,
      conversationId: 31,
      agentType: "codex",
    })
    state.bindThread({
      chatId: CHAT_B,
      threadId: 0,
      conversationId: 32,
      agentType: "codex",
    })

    assert.equal(state.getThread(CHAT_A, 0).conversationId, 31)
    assert.equal(state.getThread(CHAT_B, 0).conversationId, 32)
    assert.equal(state.getThread(303, 0), null)
    assert.equal(state.listThreads().length, 2)

    state.unbindThread(CHAT_A, 0)
    assert.equal(state.getThread(CHAT_A, 0), null)
    assert.equal(state.getThread(CHAT_B, 0).conversationId, 32)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("state: legacy threadId-keyed state.json migrates without losing bindings or sessions", () => {
  const dir = tmpDir()
  try {
    const statePath = path.join(dir, "state.json")
    const legacy = {
      updateOffset: 4242,
      primaryChatId: CHAT_A,
      threadedModeSupported: true,
      threads: {
        // v1 shape: keyed by threadId alone, owner only inside the record
        1029: {
          threadId: 1029,
          chatId: CHAT_A,
          conversationId: 692,
          folderId: 21,
          folderName: "program",
          workingDir: "D:\\work",
          agentType: "codex",
          externalId: "ext-692",
          connectionId: "conn-692",
          title: "接手",
          updatedAt: "2026-11-22T15:35:15.394Z",
        },
        1030: {
          threadId: 1030,
          chatId: CHAT_B,
          conversationId: 693,
          folderId: 21,
          folderName: "program",
          agentType: "codex",
          title: "second chat",
          updatedAt: "2026-11-22T15:36:00.000Z",
        },
      },
      activeFallbackThread: {
        threadId: 0,
        chatId: CHAT_A,
        conversationId: 682,
        folderId: 21,
        folderName: "program",
        agentType: "codex",
        title: "fallback",
        updatedAt: "2026-11-22T15:35:15.394Z",
      },
      callbacks: {
        abcd1234: {
          kind: "quick_new",
          data: { targetThreadId: 0 },
          createdAt: Date.now(),
        },
      },
    }
    fs.writeFileSync(statePath, JSON.stringify(legacy, null, 2), "utf8")

    const state = new StateStore(statePath)

    // Every pre-existing binding survives under its (chatId, threadId) identity.
    assert.equal(state.getThread(CHAT_A, 1029).conversationId, 692)
    assert.equal(state.getThread(CHAT_A, 1029).externalId, "ext-692")
    assert.equal(state.getThread(CHAT_B, 1030).conversationId, 693)
    assert.equal(state.getThread(CHAT_A, 0).conversationId, 682)
    assert.equal(state.listThreads().length, 3)
    assert.equal(state.getUpdateOffset(), 4242)
    assert.equal(state.getPrimaryChatId(), CHAT_A)
    assert.equal(state.getThreadedModeSupported(), true)
    assert.equal(state.getCallback("abcd1234").kind, "quick_new")

    // Migration is persisted, versioned, and idempotent across reloads.
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"))
    assert.equal(persisted.schemaVersion, STATE_SCHEMA_VERSION)
    assert.ok(persisted.migratedAt)

    const reloaded = new StateStore(statePath)
    assert.equal(reloaded.getThread(CHAT_A, 1029).conversationId, 692)
    assert.equal(reloaded.getThread(CHAT_B, 1030).conversationId, 693)
    assert.equal(reloaded.getThread(CHAT_A, 0).conversationId, 682)
    assert.equal(reloaded.listThreads().length, 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("state: legacy records without an owner are quarantined, never attached to a chat", () => {
  const dir = tmpDir()
  try {
    const statePath = path.join(dir, "state.json")
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        primaryChatId: CHAT_A,
        threads: {
          2001: {
            threadId: 2001,
            conversationId: 900,
            agentType: "codex",
            title: "no owner",
          },
          2002: {
            threadId: 2002,
            chatId: "not-a-number",
            conversationId: 901,
            agentType: "codex",
          },
          2003: {
            threadId: 2003,
            chatId: CHAT_A,
            conversationId: 902,
            agentType: "codex",
          },
        },
        activeFallbackThread: {
          threadId: 0,
          conversationId: 903,
          agentType: "codex",
        },
      }),
      "utf8"
    )

    const state = new StateStore(statePath)

    // The owned record still migrates normally.
    assert.equal(state.getThread(CHAT_A, 2003).conversationId, 902)

    // Owner-less records are preserved for inspection but resolve for no chat at all.
    assert.equal(state.getThread(CHAT_A, 2001), null)
    assert.equal(state.getThread(CHAT_B, 2001), null)
    assert.equal(
      state.getThread(CHAT_A, 0),
      null,
      "owner-less fallback must not land in a chat"
    )
    const quarantined = state.listUnassignedThreads()
    assert.equal(quarantined.length, 3)
    assert.deepEqual(quarantined.map((r) => r.unassignedReason).sort(), [
      "invalid_chat_id",
      "missing_chat_id",
      "missing_chat_id",
    ])
    assert.equal(state.listThreads().length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ──────────────────────────────────────────────────────────
// Bot: cross-chat replies and buttons
// ──────────────────────────────────────────────────────────

test("bot: a reply in another chat cannot consume a QuestionRequest", async () => {
  const dir = tmpDir()
  try {
    const state = new StateStore(path.join(dir, "state.json"))
    state.bindThread({
      chatId: CHAT_A,
      threadId: THREAD,
      conversationId: 11,
      folderId: 1,
      folderName: "A-folder",
      agentType: "codex",
      connectionId: "connection-chat-101",
    })
    state.bindThread({
      chatId: CHAT_B,
      threadId: THREAD,
      conversationId: 22,
      folderId: 2,
      folderName: "B-folder",
      agentType: "codex",
      connectionId: "connection-chat-202",
    })
    const { bot, calls } = makeHarness({ state })

    // Drive the real surface path so the pending-reply index is built by the bot.
    await bot._surfaceQuestionRequest("connection-chat-101", {
      question_id: "question-101",
      questions: [
        { id: "q1", header: "方式", question: "选择实现方案", options: [] },
      ],
    })
    const cardMsg = calls.tg.find(
      (c) => c.method === "sendMessage" && c.chatId === CHAT_A
    )
    assert.ok(cardMsg, "the question card must be sent to chat A")
    const cardMessageId = cardMsg.result.message_id

    // Chat B quotes the same message id (Telegram ids are per-chat) and must be refused.
    const consumed = await bot._tryConsumePendingReply(
      CHAT_B,
      THREAD,
      cardMessageId,
      "answer from chat B"
    )
    assert.equal(consumed, false, "cross-chat reply must be refused")
    assert.equal(
      codegCall(calls, "acpAnswerQuestion"),
      undefined,
      "no answer may be submitted"
    )

    // The legitimate chat still answers through the same pending entry.
    const ok = await bot._tryConsumePendingReply(
      CHAT_A,
      THREAD,
      cardMessageId,
      "answer from chat A"
    )
    assert.equal(ok, true)
    const answer = codegCall(calls, "acpAnswerQuestion")
    assert.equal(answer.args.connectionId, "connection-chat-101")
    assert.deepEqual(answer.args.answer.answers, [
      { questionId: "q1", labels: ["answer from chat A"] },
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("bot: a reply in another chat cannot submit plan feedback", async () => {
  const dir = tmpDir()
  try {
    const state = new StateStore(path.join(dir, "state.json"))
    state.bindThread({
      chatId: CHAT_A,
      threadId: THREAD,
      conversationId: 11,
      folderId: 1,
      folderName: "A-folder",
      agentType: "codex",
      connectionId: "connection-chat-101",
    })
    state.bindThread({
      chatId: CHAT_B,
      threadId: THREAD,
      conversationId: 22,
      folderId: 2,
      folderName: "B-folder",
      agentType: "codex",
      connectionId: "connection-chat-202",
    })
    const { bot, calls } = makeHarness({ state })

    await bot._surfacePlanApprovalRequest("connection-chat-101", {
      approval_id: "plan-101",
      plan_markdown: "1. edit a.js",
    })
    const planMsg = calls.tg.find(
      (c) => c.method === "sendMessage" && c.chatId === CHAT_A
    )
    assert.ok(planMsg, "the plan card must be sent to chat A")
    const planMessageId = planMsg.result.message_id

    // Simulate the "修改意见" button so a pending feedback entry exists.
    const card = [...bot.planCards.values()][0]
    bot.pendingPlanFeedbackByMsgId.set(
      bot._replyKey(card.chatId, card.threadId, planMessageId),
      `${card.connectionId}:${card.approvalId}`
    )

    const consumed = await bot._tryConsumePendingReply(
      CHAT_B,
      THREAD,
      planMessageId,
      "do something else"
    )
    assert.equal(consumed, false)
    assert.equal(codegCall(calls, "acpAnswerPlanApproval"), undefined)

    const ok = await bot._tryConsumePendingReply(
      CHAT_A,
      THREAD,
      planMessageId,
      "please split step 2"
    )
    assert.equal(ok, true)
    assert.equal(
      codegCall(calls, "acpAnswerPlanApproval").args.answer.decision,
      "request_changes"
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("bot: a reply in a different thread of the same chat cannot consume the card", async () => {
  const dir = tmpDir()
  try {
    const state = new StateStore(path.join(dir, "state.json"))
    state.bindThread({
      chatId: CHAT_A,
      threadId: THREAD,
      conversationId: 11,
      folderId: 1,
      folderName: "A-folder",
      agentType: "codex",
      connectionId: "connection-chat-101",
    })
    const { bot, calls } = makeHarness({ state })

    await bot._surfaceQuestionRequest("connection-chat-101", {
      question_id: "question-101",
      questions: [{ id: "q1", question: "选择实现方案", options: [] }],
    })
    const cardMsg = calls.tg.find((c) => c.method === "sendMessage")
    assert.ok(cardMsg)
    const cardMessageId = cardMsg.result.message_id

    assert.equal(
      await bot._tryConsumePendingReply(
        CHAT_A,
        99,
        cardMessageId,
        "wrong thread"
      ),
      false
    )
    assert.equal(codegCall(calls, "acpAnswerQuestion"), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("bot: card buttons from another chat are refused (perm, question, plan)", async () => {
  const dir = tmpDir()
  try {
    const state = new StateStore(path.join(dir, "state.json"))
    state.bindThread({
      chatId: CHAT_A,
      threadId: THREAD,
      conversationId: 11,
      agentType: "codex",
    })
    const { bot, calls } = makeHarness({ state })

    const permKey = "connection-chat-101:req-101"
    bot.permissionCards.set(permKey, {
      connectionId: "connection-chat-101",
      requestId: "req-101",
      chatId: CHAT_A,
      threadId: THREAD,
      messageId: 11,
      options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
      shortId: "permid01",
      baseHtml: "<b>权限确认</b>",
    })
    const permSid = state.registerCallback("perm", {
      connectionId: "connection-chat-101",
      requestId: "req-101",
      cardKey: permKey,
      options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
      chatId: CHAT_A,
      threadId: THREAD,
    })

    const qCard = questionCard({ messageId: 12, shortId: "qshort01" })
    bot.questionCards.set(`${qCard.connectionId}:${qCard.questionId}`, qCard)
    const qSid = state.registerCallback("question", {
      cardKey: `${qCard.connectionId}:${qCard.questionId}`,
      chatId: CHAT_A,
      threadId: THREAD,
    })

    const pCard = planCard({ messageId: 13, shortId: "plansh01" })
    bot.planCards.set(`${pCard.connectionId}:${pCard.approvalId}`, pCard)
    const planSid = state.registerCallback("plan", {
      cardKey: `${pCard.connectionId}:${pCard.approvalId}`,
      chatId: CHAT_A,
      threadId: THREAD,
    })

    const foreign = (data) => ({
      id: `cq-${data}`,
      from: { id: CHAT_B },
      data,
      message: {
        message_id: 11,
        chat: { id: CHAT_B },
        message_thread_id: THREAD,
      },
    })

    await bot.handleUpdate({ callback_query: foreign(`perm:${permSid}:0`) })
    await bot.handleUpdate({ callback_query: foreign(`qopt:${qSid}:0:0`) })
    await bot.handleUpdate({ callback_query: foreign(`qsub:${qSid}:0`) })
    await bot.handleUpdate({ callback_query: foreign(`qskip:${qSid}`) })
    await bot.handleUpdate({
      callback_query: foreign(`plan:${planSid}:approve`),
    })

    assert.equal(
      codegCall(calls, "acpRespondPermission"),
      undefined,
      "no permission may be granted cross-chat"
    )
    assert.equal(
      codegCall(calls, "acpAnswerQuestion"),
      undefined,
      "no question may be answered cross-chat"
    )
    assert.equal(
      codegCall(calls, "acpAnswerPlanApproval"),
      undefined,
      "no plan may be approved cross-chat"
    )
    assert.ok(
      bot.questionCards.size === 1,
      "the card must remain pending for its own chat"
    )
    assert.ok(
      bot.planCards.size === 1,
      "the plan card must remain pending for its own chat"
    )

    // The owner chat can still act on the same buttons.
    await bot.handleUpdate({
      callback_query: {
        id: "cq-own",
        from: { id: CHAT_A },
        data: `perm:${permSid}:0`,
        message: {
          message_id: 11,
          chat: { id: CHAT_A },
          message_thread_id: THREAD,
        },
      },
    })
    assert.equal(
      codegCall(calls, "acpRespondPermission").args.optionId,
      "allow"
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("bot: scoped menu callbacks (mode/cfg/close/session) are refused in another chat", async () => {
  const dir = tmpDir()
  try {
    const state = new StateStore(path.join(dir, "state.json"))
    state.bindThread({
      chatId: CHAT_A,
      threadId: THREAD,
      conversationId: 11,
      agentType: "codex",
    })
    const { bot, calls } = makeHarness({ state })

    const modeSid = state.registerCallback("set_mode", {
      connectionId: "conn-a",
      modes: [{ id: "bypass", name: "Bypass" }],
      chatId: CHAT_A,
      threadId: THREAD,
    })
    const cfgSid = state.registerCallback("set_cfg", {
      connectionId: "conn-a",
      options: [
        {
          id: "model",
          name: "Model",
          current_value: "a",
          values: [{ value: "b", name: "B" }],
        },
      ],
      chatId: CHAT_A,
      threadId: THREAD,
    })
    const closeSid = state.registerCallback("close_topic", {
      threadId: THREAD,
      conversationId: 11,
      connectionId: "conn-a",
      chatId: CHAT_A,
    })

    const foreign = (data) => ({
      id: `cq-${data}`,
      from: { id: CHAT_B },
      data,
      message: {
        message_id: 20,
        chat: { id: CHAT_B },
        message_thread_id: THREAD,
      },
    })

    await bot.handleUpdate({ callback_query: foreign(`mode:${modeSid}:0`) })
    await bot.handleUpdate({ callback_query: foreign(`cfgval:${cfgSid}:0:0`) })
    await bot.handleUpdate({ callback_query: foreign(`cls:${closeSid}:topic`) })

    assert.equal(codegCall(calls, "acpSetMode"), undefined)
    assert.equal(codegCall(calls, "acpSetConfigOption"), undefined)
    assert.equal(
      codegCall(calls, "acpDisconnect"),
      undefined,
      "cross-chat close must not disconnect the session"
    )
    assert.ok(
      state.getThread(CHAT_A, THREAD),
      "the binding must survive a cross-chat close attempt"
    )

    // The owner chat still applies its own menu action.
    await bot.handleUpdate({
      callback_query: {
        id: "cq-own-mode",
        from: { id: CHAT_A },
        data: `mode:${modeSid}:0`,
        message: {
          message_id: 20,
          chat: { id: CHAT_A },
          message_thread_id: THREAD,
        },
      },
    })
    assert.equal(codegCall(calls, "acpSetMode").args.modeId, "bypass")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("bot: prompts route to the binding of their own chat when threadIds collide", async () => {
  const dir = tmpDir()
  try {
    const state = new StateStore(path.join(dir, "state.json"))
    state.bindThread({
      chatId: CHAT_A,
      threadId: THREAD,
      conversationId: 11,
      folderId: 1,
      folderName: "A-folder",
      workingDir: "D:\\work\\a",
      agentType: "codex",
      connectionId: "conn-a",
    })
    state.bindThread({
      chatId: CHAT_B,
      threadId: THREAD,
      conversationId: 22,
      folderId: 2,
      folderName: "B-folder",
      workingDir: "D:\\work\\b",
      agentType: "codex",
      connectionId: "conn-b",
    })
    const { bot, calls } = makeHarness({ state })
    // Both bound connections are live, so no reconnect is attempted.
    bot.codeg.acpListConnections = async () => [
      { id: "conn-a", agent_type: "codex", status: "connected" },
      { id: "conn-b", agent_type: "codex", status: "connected" },
    ]

    await bot.handleUpdate({
      message: {
        message_id: 30,
        from: { id: CHAT_B },
        chat: { id: CHAT_B, type: "private" },
        message_thread_id: THREAD,
        text: "hello from B",
      },
    })

    const prompts = calls.codeg.filter((c) => c.method === "acpPrompt")
    assert.equal(prompts.length, 1)
    assert.equal(
      prompts[0].args.connectionId,
      "conn-b",
      "chat B must drive chat B connection"
    )
    assert.deepEqual(prompts[0].args.blocks, [
      { type: "text", text: "hello from B" },
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("bot: desktop-originated cards are not guessed into a chat when several chats are known", async () => {
  const dir = tmpDir()
  try {
    const state = new StateStore(path.join(dir, "state.json"))
    state.setPrimaryChatId(CHAT_A)
    state.setPrimaryChatId(CHAT_B)
    const { bot, calls } = makeHarness({ state })

    const target = await bot._resolveTargetForConnection("conn-desktop")
    assert.equal(
      target,
      null,
      "ambiguous desktop target must fail closed instead of leaking to one chat"
    )
    assert.equal(calls.tg.length, 0)

    // With a single known chat the desktop flow keeps working.
    const single = new StateStore(path.join(dir, "single.json"))
    single.setPrimaryChatId(CHAT_A)
    const solo = makeHarness({ state: single, allowedUserIds: [CHAT_A] })
    const soloTarget =
      await solo.bot._resolveTargetForConnection("conn-desktop")
    assert.equal(soloTarget.chatId, CHAT_A)
    assert.equal(soloTarget.threadId, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("bot: ownerless legacy callbacks keep working for a single chat only", async () => {
  const dir = tmpDir()
  try {
    // Single known chat: a keyboard created before this upgrade still works.
    const state = new StateStore(path.join(dir, "one.json"))
    state.setPrimaryChatId(CHAT_A)
    const { bot, calls } = makeHarness({ state, allowedUserIds: [CHAT_A] })

    const legacySid = state.registerCallback("quick_sessions", {})
    await bot.handleUpdate({
      callback_query: {
        id: "cq-legacy",
        from: { id: CHAT_A },
        data: `qact:${legacySid}`,
        message: {
          message_id: 40,
          chat: { id: CHAT_A },
          message_thread_id: THREAD,
        },
      },
    })
    assert.ok(
      calls.codeg.some((c) => c.method === "listAllConversations"),
      "the legacy keyboard must still open the session list"
    )

    // A second chat makes the owner ambiguous, so the same shape is refused.
    const multi = new StateStore(path.join(dir, "two.json"))
    multi.setPrimaryChatId(CHAT_A)
    multi.setPrimaryChatId(CHAT_B)
    const second = makeHarness({ state: multi })
    const orphanSid = multi.registerCallback("quick_sessions", {})
    await second.bot.handleUpdate({
      callback_query: {
        id: "cq-orphan",
        from: { id: CHAT_B },
        data: `qact:${orphanSid}`,
        message: {
          message_id: 41,
          chat: { id: CHAT_B },
          message_thread_id: THREAD,
        },
      },
    })
    assert.ok(
      !second.calls.codeg.some((c) => c.method === "listAllConversations"),
      "an ownerless callback must be refused once several chats exist"
    )
    const refusal = second.calls.tg.find(
      (c) => c.method === "answerCallbackQuery"
    )
    assert.match(refusal.opts.text, /不属于当前聊天/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
