import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import {
  PiRpcProcess,
  PiRpcSpawnError,
  SESSION_STATS_TIMEOUT_MS,
  type PiExit,
  type PiRpcEvent,
  type PiSessionStats
} from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { McpBridgeLaunch, piTooOldMessage, type McpDeliveryReport } from './mcp-bridge.js'
import { SessionStore } from './session-store.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultText, toolResultToText } from './translate/pi-tools.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  clientCaps?: ClientSessionCaps
}

/**
 * The unstable ACP session extensions the client advertised at `initialize`
 * (`clientCapabilities.session`). Each REPLACES a fallback the adapter would
 * otherwise use, so neither is sent unless the client asked for it.
 */
export type ClientSessionCaps = {
  /** Session Notices RFD: pi extension notifications become `notice`s. */
  notices: boolean
  /** Session Compaction RFD: pi's compaction becomes `compaction_update`s. */
  compaction: boolean
}

const NO_SESSION_CAPS: ClientSessionCaps = { notices: false, compaction: false }

/** How a turn ended, in ACP terms. Failures reject the turn instead. */
export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens'

/**
 * A finished turn: its stop reason, and whether pi HANDLED the prompt without
 * a run (an extension command or input handler consumed it), in which case
 * the turn produced no reply by design.
 */
export type TurnOutcome = { stopReason: StopReason; handled: boolean }

function outcome(stopReason: StopReason, handled = false): TurnOutcome {
  return { stopReason, handled }
}

/** What happened to a `_session/steering` message. */
export type SteerOutcome = 'injected' | 'promptRequired'

/** The last assistant message pi finished during a turn. */
type AssistantOutcome = {
  stopReason: string | null
  errorMessage: string | null
}

type PendingTurn = {
  resolve: (outcome: TurnOutcome) => void
  reject: (err: unknown) => void
  lastAssistant: AssistantOutcome | null
  /** pi consumed the prompt without starting a run (disposition `handled`). */
  handled: boolean
  /**
   * This turn's steers pi has not been seen delivering (a request still in
   * flight included), in the order they were sent.
   */
  steers: SentSteer[]
  /** pi queued at least one of this turn's steers. */
  queuedSteer: boolean
  /** This turn's steer requests pi has not answered yet. */
  inflightSteers: Set<Promise<unknown>>
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (outcome: TurnOutcome) => void
  reject: (err: unknown) => void
}

/** A steer sent during the current turn, as it was sent. */
type SentSteer = { text: string; images: unknown[] }

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

/**
 * Map pi's `stats.contextUsage` to an ACP `usage_update`. Returns null whenever pi
 * reports no trustworthy token count (e.g. `tokens: null` right after compaction) or
 * the values are not usable integers.
 */
function toUsageUpdate(stats: PiSessionStats | null | undefined): SessionUpdate | null {
  const used = stats?.contextUsage?.tokens
  const size = stats?.contextUsage?.contextWindow

  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null

  return { sessionUpdate: 'usage_update', used, size }
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

/**
 * The text a turn failure reports. pi's `errorMessage` is the provider's own
 * words (status + body), which is the actionable part; the fallback only names
 * the stop reason so the client still shows *that* the turn failed.
 */
function turnFailureMessage(outcome: AssistantOutcome): string {
  const text = outcome.errorMessage?.trim()
  return text ? text : 'pi ended the turn with an error'
}

/**
 * A failed turn, worded as pi worded it. Built directly rather than through
 * `RequestError.internalError`, whose "Internal error:" prefix would misname a
 * provider's refusal as a bug in the adapter.
 */
export function turnError(message: string): RequestError {
  return new RequestError(-32603, message)
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * A turn still in flight ends `cancelled`: nobody else will ever settle it.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.abandon()
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    const bridge = McpBridgeLaunch.prepare(params.mcpServers)
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
        extensions: bridge.extensions,
        env: bridge.env
      })
    } catch (e) {
      bridge.cleanup()
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }
    const bridged = bridge.collect()
    if (bridged.piSupportsMcp === false) {
      proc.dispose()
      throw turnError(piTooOldMessage())
    }
    const mcpDelivery = bridged.report

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      mcpDelivery,
      clientCaps: params.clientCaps
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(
    sessionId: string,
    params: SessionCreateParams & {
      proc: PiRpcProcess
      mcpDelivery?: McpDeliveryReport | null
    }
  ): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      mcpDelivery: params.mcpDelivery ?? null,
      clientCaps: params.clientCaps
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]
  /** How the session's MCP servers reached pi; `null` when none were given. */
  readonly mcpDelivery: McpDeliveryReport | null
  private readonly clientCaps: ClientSessionCaps

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // `agent_settled` arrived and the turn is being wrapped up: too late to steer into it.
  private settling = false
  // Set once pi exited; every later request fails with it.
  private deadMessage: string | null = null

  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()
  // Tool calls the model is still streaming, by content index (pi's wire is delta-only:
  // only `toolcall_start` carries the id and name).
  private streamingToolCalls = new Map<number, { id: string; toolName: string }>()
  // Calls a tool made through `ctx.executeTool()` (codemode scripts), child -> parent.
  private nestedParents = new Map<string, string>()

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Native steering: pi's queues as it last reported them (`queue_update`). pi
  // drops a message from its queue right before it delivers it, so what is
  // still listed when a run settles was never delivered. The steers themselves
  // are kept on their turn.
  private piQueue: { steering: string[]; followUp: string[] } = {
    steering: [],
    followUp: []
  }

  // The compaction in progress (pi announces start and end separately).
  private compaction: { id: string; startedAt: number; reason: string } | null = null

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    mcpDelivery?: McpDeliveryReport | null
    clientCaps?: ClientSessionCaps
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.mcpDelivery = opts.mcpDelivery ?? null
    this.clientCaps = opts.clientCaps ?? NO_SESSION_CAPS
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []

    this.proc.onEvent(ev => this.handlePiEvent(ev))
    // Tests hand in fakes without an exit channel.
    if (typeof this.proc.onExit === 'function') this.proc.onExit(exit => this.handlePiExit(exit))
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  /** Whether a prompt turn is in flight. */
  get hasActiveTurn(): boolean {
    return this.pendingTurn !== null
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    return (await this.promptTurn(message, images)).stopReason
  }

  /** {@link prompt}, also saying whether pi handled it without a run. */
  async promptTurn(message: string, images: unknown[] = []): Promise<TurnOutcome> {
    if (this.deadMessage) throw turnError(this.deadMessage)

    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<TurnOutcome>((resolve, reject) => {
      const queued: QueuedTurn = {
        message: expandedMessage,
        images,
        resolve,
        reject
      }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })
        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  /**
   * Push a message into the RUNNING turn (`_session/steering`).
   *
   * pi queues it and delivers it before its next model call, and keeps its run
   * going while anything is queued — so the answer is `injected` as soon as pi
   * has it, and the client's request never waits on the run. A steer that
   * reaches pi after its last look at the queue is run as a continuation of
   * this same turn when the run settles (see `continueWithLeftoverSteers`).
   *
   * `promptRequired` means pi did not take it, and the client should send it as
   * a normal prompt: no turn is running or it is already ending, or the message
   * has no text — pi lists a queued message by its text, so one without any
   * would never show as still waiting, and could not be taken back.
   */
  async steer(message: string, images: unknown[] = []): Promise<SteerOutcome> {
    const turn = this.pendingTurn
    if (this.deadMessage || !turn || this.settling || this.cancelRequested) return 'promptRequired'

    const text = expandSlashCommand(message, this.fileCommands)
    if (!text.trim()) return 'promptRequired'

    // Recorded before it is sent: pi may deliver it before its answer is read.
    const sent: SentSteer = { text, images }
    turn.steers.push(sent)
    const forget = () => {
      const index = turn.steers.indexOf(sent)
      if (index !== -1) turn.steers.splice(index, 1)
    }
    const call = this.proc.steer(text, images).then(
      disposition => {
        // `handled`: an input handler consumed it — taken, nothing queued.
        if (disposition === 'handled') forget()
        else turn.queuedSteer = true
      },
      (error: unknown) => {
        forget()
        throw error
      }
    )
    turn.inflightSteers.add(call)
    try {
      await call
      return 'injected'
    } catch {
      return 'promptRequired'
    } finally {
      turn.inflightSteers.delete(call)
    }
  }

  /**
   * Wait until pi answered every steer sent for `turn`. Not time-bound on
   * purpose: one answered after its turn ended would be lost or land in the
   * next turn, and the client is holding its connection for that answer anyway.
   */
  private async steersAnswered(turn: PendingTurn): Promise<void> {
    await Promise.allSettled([...turn.inflightSteers])
  }

  /**
   * pi delivered a user message: if it is one of the current turn's steers,
   * drop that record, so what is left is what pi still holds. Matched on the
   * whole content, text and images; two steers that match the same message
   * are interchangeable, so taking the first keeps every image with its own
   * text.
   */
  private forgetDeliveredSteer(message: unknown): void {
    const steers = this.pendingTurn?.steers
    if (!steers?.length) return
    const content = (message as { content?: unknown })?.content
    const parts = Array.isArray(content)
      ? (content as Array<Record<string, unknown>>)
      : [{ type: 'text', text: content }]
    const text = parts
      .filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => p.text as string)
      .join('')
    const images = parts.filter(p => p?.type === 'image')
    const index = steers.findIndex(
      s =>
        s.text === text &&
        s.images.length === images.length &&
        s.images.every((image, i) => {
          const a = image as Record<string, unknown> | null
          return a?.data === images[i].data && a?.mimeType === images[i].mimeType
        })
    )
    if (index !== -1) steers.splice(index, 1)
  }

  /** Whether pi's queues, as last reported, still hold a message. */
  private piQueueHoldsMessages(): boolean {
    return [...this.piQueue.steering, ...this.piQueue.followUp].some(t => t.trim())
  }

  /**
   * Take back what pi still holds of this turn's steers, for a turn that will
   * not run them (cancelled, or its prompt was refused): pi would otherwise
   * deliver them along with the NEXT prompt.
   */
  private async dropLeftoverSteers(turn: PendingTurn): Promise<void> {
    if (!turn.queuedSteer && !turn.inflightSteers.size) return
    await this.steersAnswered(turn)
    turn.steers = []
    // Whether pi still holds one of OURS cannot be told apart from an
    // extension's message of the same text; anything pi still holds goes.
    if (!turn.queuedSteer || !this.piQueueHoldsMessages()) return
    turn.queuedSteer = false
    try {
      await this.proc.clearQueue()
    } catch {
      // pi gone; nothing left to take back
    }
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve(outcome('cancelled'))
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    if (this.deadMessage) return

    // A cancelled turn's steers go with it.
    if (this.pendingTurn) await this.dropLeftoverSteers(this.pendingTurn)

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  /**
   * The session is being discarded (closed, replaced): end whatever is in flight
   * so no request waits on a pi process that is about to be killed.
   */
  abandon(): void {
    for (const t of this.turnQueue.splice(0, this.turnQueue.length)) t.resolve(outcome('cancelled'))
    this.pendingTurn?.resolve(outcome('cancelled'))
    this.pendingTurn = null
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  /** Emit an update kind the pinned SDK schema does not know yet. */
  private emitRaw(update: Record<string, unknown>): void {
    this.emit(update as unknown as SessionUpdate)
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  /**
   * Best-effort: publish the real pi context-window occupancy as ACP `usage_update`.
   * Queued updates are flushed even when the stats query fails or times out, so callers
   * can await this before resolving `session/prompt`.
   */
  async publishContextUsage(): Promise<void> {
    try {
      // Older/stubbed pi processes may not expose the stats RPC at all.
      if (typeof this.proc.getSessionStats === 'function' && !this.deadMessage) {
        const update = toUsageUpdate(await this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS))
        if (update) this.emit(update)
      }
    } catch {
      // Context usage is auxiliary; never fail or delay the turn because of it.
    }

    await this.flushEmits()
  }

  private async settleTurn(): Promise<void> {
    const turn = this.pendingTurn
    if (!turn || this.settling) return
    this.settling = true
    let continued = false
    try {
      // A steer pi answers only now reached it after the run's last look at
      // its queue; wait for it so the check below sees it.
      await this.steersAnswered(turn)
      if (!this.cancelRequested && this.pendingTurn === turn) continued = await this.continueWithLeftoverSteers(turn)
      if (!continued) {
        turn.steers = []
        // Ensure all updates derived from pi events (plus the final usage update) are
        // delivered before we resolve the ACP `session/prompt` request.
        await this.publishContextUsage()
        if (this.pendingTurn === turn) {
          this.pendingTurn = null
          this.inAgentLoop = false
          this.resolveTurn(turn)
        }
      }
    } finally {
      this.settling = false
    }

    if (!continued) this.startNextQueued()
  }

  /**
   * Steers pi accepted (answered `injected`) that were still queued when its
   * run settled: they arrived after the run's last look at the queue. Left
   * there, pi would deliver them with the NEXT prompt, so they are taken back
   * and run now, as a continuation of the same turn — together with anything
   * else that was waiting in the same queues. Returns whether it did.
   */
  private async continueWithLeftoverSteers(turn: PendingTurn): Promise<boolean> {
    if (!turn.queuedSteer || !this.piQueueHoldsMessages()) return false
    const waiting = [...turn.steers]
    let cleared: { steering: string[]; followUp: string[] }
    try {
      cleared = await this.proc.clearQueue()
    } catch {
      return false
    }
    turn.steers = []
    turn.queuedSteer = false
    const texts = [...cleared.steering, ...cleared.followUp].filter(t => t.trim())
    if (!texts.length || this.pendingTurn !== turn) return false

    // pi hands back text only; the images come from what was sent.
    const images: unknown[] = []
    for (const text of texts) {
      const index = waiting.findIndex(s => s.text === text)
      if (index === -1) continue
      images.push(...waiting[index].images)
      waiting.splice(index, 1)
    }
    turn.handled = false
    this.inAgentLoop = false
    this.runPrompt(turn, texts.join('\n\n'), images)
    return true
  }

  /** Resolve or reject a finished turn from what pi reported. */
  private resolveTurn(turn: PendingTurn | null): void {
    if (!turn) return
    if (this.cancelRequested) {
      turn.resolve(outcome('cancelled'))
      return
    }
    const last = turn.lastAssistant
    switch (last?.stopReason) {
      case 'error':
        // pi exhausted its retries (or the error was not retryable). Reject so the
        // client can tell a failed turn from one that merely said nothing.
        turn.reject(turnError(turnFailureMessage(last)))
        return
      case 'aborted':
        turn.resolve(outcome('cancelled'))
        return
      case 'length':
        turn.resolve(outcome('max_tokens'))
        return
      default:
        turn.resolve(outcome('end_turn', turn.handled))
    }
  }

  private startNextQueued(): void {
    const next = this.turnQueue.shift()
    if (next) {
      this.startTurn(next)
    } else {
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: false } }
      })
    }
  }

  /** pi exited. Nothing it was doing can finish; say why, once, everywhere. */
  private handlePiExit(exit: PiExit): void {
    const detail = exit.stderrTail.trim().split('\n').slice(-5).join('\n')
    this.deadMessage = `pi process exited (code=${exit.code}, signal=${exit.signal})` + (detail ? `: ${detail}` : '')
    // In-flight steer requests are rejected by the process layer.
    const turn = this.pendingTurn
    this.pendingTurn = null
    const queued = this.turnQueue.splice(0, this.turnQueue.length)
    const error = turnError(this.deadMessage)
    void this.flushEmits().finally(() => {
      if (turn) {
        if (this.cancelRequested) turn.resolve(outcome('cancelled'))
        else turn.reject(error)
      }
      for (const t of queued) t.reject(error)
    })
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    const parentMeta = this.parentMeta(params.toolCallId)
    const meta = {
      ...(params.includeTerminal ? bashTerminalInfoMeta(params.toolCallId, this.cwd) : {}),
      ...(parentMeta ?? {})
    }
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(Object.keys(meta).length ? { _meta: meta } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  /** `_meta` naming the tool call that made `toolCallId` (codemode), if any. */
  private parentMeta(toolCallId: string): Record<string, unknown> | null {
    const parentToolCallId = this.nestedParents.get(toolCallId)
    return parentToolCallId ? { piAcp: { parentToolCallId } } : null
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
    this.nestedParents.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.streamingToolCalls.clear()

    const turn: PendingTurn = {
      resolve: t.resolve,
      reject: t.reject,
      lastAssistant: null,
      handled: false,
      steers: [],
      queuedSteer: false,
      inflightSteers: new Set()
    }
    this.pendingTurn = turn

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    this.runPrompt(turn, t.message, t.images)
  }

  /**
   * Send `turn`'s prompt (its first, or a continuation) to pi. Completion is
   * determined by pi events, not the RPC response: the response only
   * acknowledges acceptance, and retry, compaction, or queued continuations may
   * emit several `agent_end`s before `agent_settled`.
   */
  private runPrompt(turn: PendingTurn, message: string, images: unknown[]): void {
    this.proc
      .prompt(message, images)
      .then(disposition => {
        if (this.pendingTurn !== turn) return
        // An extension command or input handler consumed the prompt: no run starts,
        // so no `agent_settled` will ever come for it (pi 0.99+).
        if (disposition === 'handled' && !this.inAgentLoop) {
          turn.handled = true
          void this.settleTurn()
          return
        }
        // Cancelled while pi was still preparing the prompt: that abort found no
        // run to stop, and the run has started since.
        if (this.cancelRequested && disposition === 'started') void this.proc.abort().catch(() => {})
      })
      .catch(err => {
        // The prompt was rejected before pi accepted it (no model, bad config...).
        void this.flushEmits().finally(() => this.endRefusedTurn(turn, err))
      })
  }

  /** pi refused `turn`'s prompt: fail the turn, take back its steers, go on. */
  private async endRefusedTurn(turn: PendingTurn, err: unknown): Promise<void> {
    if (this.pendingTurn !== turn) return
    if (this.cancelRequested) {
      turn.resolve(outcome('cancelled'))
    } else {
      // Auth/config issues surface as AUTH_REQUIRED so clients can offer a login.
      const authErr = maybeAuthRequiredError(err)
      turn.reject(authErr ?? turnError(String((err as Error)?.message ?? err)))
    }

    // The turn stays this session's (ending) until pi gave back the steers it
    // took for the run that never started: a prompt arriving meanwhile queues
    // behind it, and no run may start while pi still holds them — it would
    // deliver them first thing.
    this.settling = true
    try {
      await this.dropLeftoverSteers(turn)
    } finally {
      this.settling = false
    }
    if (this.pendingTurn !== turn) return
    this.pendingTurn = null
    this.inAgentLoop = false

    // A prompt queued behind this one gets its own answer from pi rather than
    // waiting forever.
    this.startNextQueued()
  }

  private emitToolCallStart(params: {
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    line?: number
  }): void {
    const existing = this.currentToolCalls.get(params.toolCallId)
    const status = existing === 'in_progress' ? 'in_progress' : params.status
    this.currentToolCalls.set(params.toolCallId, status)
    const locations = params.args === undefined ? undefined : toToolCallLocations(params.args, this.cwd, params.line)
    const meta = this.parentMeta(params.toolCallId)

    if (!existing) {
      this.emit({
        sessionUpdate: 'tool_call',
        toolCallId: params.toolCallId,
        title: params.toolName,
        kind: toToolKind(params.toolName),
        status,
        locations,
        ...(params.args === undefined ? {} : { rawInput: params.args }),
        ...(meta ? { _meta: meta } : {})
      })
      return
    }

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status,
      locations,
      ...(params.args === undefined ? {} : { rawInput: params.args }),
      ...(meta ? { _meta: meta } : {})
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_start': {
        // pi hands a queued steer to the model as a user message.
        if ((ev as any).message?.role === 'user') this.forgetDeliveredSteer((ev as any).message)
        break
      }

      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_end') {
          this.handleStreamedToolCall(ame)
        }
        break
      }

      case 'message_end': {
        const message = (ev as any).message
        if (message?.role === 'assistant' && this.pendingTurn) {
          this.pendingTurn.lastAssistant = {
            stopReason: typeof message.stopReason === 'string' ? message.stopReason : null,
            errorMessage: typeof message.errorMessage === 'string' ? message.errorMessage : null
          }
        }
        break
      }

      case 'queue_update': {
        const texts = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [])
        const next = {
          steering: texts((ev as any).steering),
          followUp: texts((ev as any).followUp)
        }
        this.piQueue = next
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        const parent = (ev as any).parentToolCallId
        if (typeof parent === 'string' && parent) this.nestedParents.set(toolCallId, parent)
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              const snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, {
                path: p,
                oldText: snapshotOldText
              })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        this.emitToolCallStart({
          toolCallId,
          toolName,
          args,
          status: 'in_progress',
          line
        })
        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        if (this.fileMutationToolCallIds.has(toolCallId)) break

        // A partial result without text (codemode's call list, an MCP progress
        // tick) is not output yet: sending it would print its JSON.
        const text = toolResultText(partial)
        if (!text) break

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[],
          rawOutput: partial
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const text = toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        const meta = this.parentMeta(toolCallId)
        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result }),
          ...(meta ? { _meta: meta } : {})
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        // pi reports the final failure on the assistant message; only a recovery is news here.
        if ((ev as any).success === false) break
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'compaction_start': {
        const reason = typeof (ev as any).reason === 'string' ? (ev as any).reason : 'threshold'
        this.compaction = {
          id: `pi-compaction-${crypto.randomUUID()}`,
          startedAt: Date.now(),
          reason
        }
        if (this.clientCaps.compaction) {
          this.emitCompaction('in_progress', reason, null)
        } else if (reason !== 'manual') {
          // A client without the compaction extension still hears about the
          // automatic kind (a manual `/compact` answers on its own).
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Context nearing limit, running automatic compaction...'
            } satisfies ContentBlock
          })
        }
        break
      }

      case 'compaction_end': {
        const reason = typeof (ev as any).reason === 'string' ? (ev as any).reason : this.compaction?.reason
        const result = (ev as any).result
        const aborted = Boolean((ev as any).aborted)
        const error = typeof (ev as any).errorMessage === 'string' ? (ev as any).errorMessage : null
        const status = result ? 'completed' : aborted ? 'cancelled' : 'failed'
        if (this.clientCaps.compaction) {
          this.emitCompaction(status, reason ?? 'threshold', result ?? null, error)
        } else if (reason !== 'manual' && status === 'completed') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Automatic compaction finished; context was summarized to continue the session.'
            } satisfies ContentBlock
          })
        }
        this.compaction = null
        break
      }

      // pi before the `compaction_*` events (pre-0.8x) only said it in prose.
      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        void this.settleTurn()
        break
      }

      default:
        break
    }
  }

  /**
   * Surface a tool call while the model is still writing it. pi's wire is
   * delta-only (0.84+): `toolcall_start` carries the id and name, the deltas only
   * raw argument text, `toolcall_end` the complete call.
   */
  private handleStreamedToolCall(ame: any): void {
    const contentIndex = typeof ame?.contentIndex === 'number' ? ame.contentIndex : 0

    if (ame.type === 'toolcall_start') {
      // pi < 0.84 sent the call (or a partial message snapshot holding it)
      // instead of top-level id/toolName.
      const snapshot = ame?.toolCall ?? ame?.partial?.content?.[contentIndex]
      const id = String(ame?.id ?? snapshot?.id ?? '')
      const toolName = String(ame?.toolName ?? snapshot?.name ?? 'tool')
      if (!id) return
      this.streamingToolCalls.set(contentIndex, { id, toolName })
      const args =
        snapshot?.arguments && typeof snapshot.arguments === 'object' ? (snapshot.arguments as unknown) : undefined
      // A bash card is announced with its command (the terminal title), so it waits
      // for the complete call; every other tool shows up right away.
      if (isBashTool(toolName)) {
        if (args !== undefined && !this.currentToolCalls.has(id)) {
          this.currentToolCalls.set(id, 'pending')
          this.emitBashToolCall({
            sessionUpdate: 'tool_call',
            toolCallId: id,
            toolName,
            args,
            status: 'pending',
            locations: toToolCallLocations(args, this.cwd),
            includeTerminal: true
          })
        }
      } else if (!this.currentToolCalls.has(id)) {
        this.emitToolCallStart({
          toolCallId: id,
          toolName,
          args,
          status: 'pending'
        })
      }
      return
    }

    // toolcall_end
    const toolCall = ame?.toolCall ?? ame?.partial?.content?.[contentIndex]
    const known = this.streamingToolCalls.get(contentIndex)
    this.streamingToolCalls.delete(contentIndex)
    const id = String(toolCall?.id ?? known?.id ?? '')
    const toolName = String(toolCall?.name ?? known?.toolName ?? 'tool')
    if (!id) return
    const args =
      toolCall?.arguments && typeof toolCall.arguments === 'object' ? (toolCall.arguments as unknown) : undefined

    if (isBashTool(toolName)) {
      const existingStatus = this.currentToolCalls.get(id)
      if (!existingStatus) this.currentToolCalls.set(id, 'pending')
      this.emitBashToolCall({
        sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
        toolCallId: id,
        toolName,
        args,
        status: existingStatus ?? 'pending',
        locations: toToolCallLocations(args, this.cwd),
        includeTerminal: !existingStatus
      })
      return
    }

    this.emitToolCallStart({
      toolCallId: id,
      toolName,
      args,
      status: 'pending'
    })
  }

  /**
   * Report a compaction as an ACP `compaction_update`, the frame codeg (and the
   * unstable ACP compaction extension) renders as one card per compaction. The
   * `contextCompaction` block mirrors what codeg's pi history parser writes for
   * the same compaction, so the live card and the reloaded one agree.
   */
  private emitCompaction(
    status: 'in_progress' | 'completed' | 'failed' | 'cancelled',
    reason: string,
    result: any,
    error: string | null = null
  ): void {
    const compaction = this.compaction ?? {
      id: `pi-compaction-${crypto.randomUUID()}`,
      startedAt: Date.now(),
      reason
    }
    const block: Record<string, unknown> = {
      version: 1,
      trigger: reason === 'manual' ? 'manual' : 'automatic'
    }
    if (typeof result?.tokensBefore === 'number') block.preTokens = result.tokensBefore
    if (typeof result?.estimatedTokensAfter === 'number') block.postTokens = result.estimatedTokensAfter
    if (status !== 'in_progress') block.durationMs = Math.max(0, Date.now() - compaction.startedAt)
    if (error) block.error = error

    this.emitRaw({
      sessionUpdate: 'compaction_update',
      compactionId: compaction.id,
      status,
      ...(typeof result?.summary === 'string' && result.summary
        ? { summary: [{ type: 'text', text: result.summary }] }
        : {}),
      ...(error ? { error } : {}),
      _meta: { contextCompaction: block }
    })
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'notify') {
      // pi's `ctx.ui.notify()` is a transient toast, never conversation: a
      // client with the Session Notices extension shows it as one; any other
      // gets the old chunk, marked so it can be told from the reply.
      const message = stringProp(ev, 'message') ?? 'Pi notification'
      const level = stringProp(ev, 'notifyType') ?? 'info'
      if (this.clientCaps.notices && message.trim()) {
        this.emitRaw({
          sessionUpdate: 'notice',
          severity: level === 'warning' || level === 'error' ? level : 'info',
          title: message,
          _meta: { piAcp: { notify: { level } } }
        })
      } else {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: message } satisfies ContentBlock,
          _meta: { piAcp: { notify: { level } } }
        })
      }
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
    case 'ls':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
    case 'powershell':
      return 'execute'
    case 'grep':
    case 'find':
    case 'tool_search':
      return 'search'
    default:
      return 'other'
  }
}
