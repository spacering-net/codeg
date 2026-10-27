import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'
import { JsonlSplitter } from './jsonl.js'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

type PiImagePayload = { type: 'image'; mimeType: string; data: string }

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'steer'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort'; id?: string }
  | { type: 'clear_queue'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'get_available_thinking_levels'; id?: string }
  | { type: 'set_thinking_level'; id?: string; level: string }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true }

export type PiRpcEvent = Record<string, unknown>

/**
 * What pi did with a submitted prompt (pi 0.99+). `handled` means an extension
 * command or input handler consumed it and NO run starts, so no `agent_settled`
 * will follow. `undefined` means an older pi that does not report it.
 */
export type PromptDisposition = 'started' | 'queued' | 'handled'

/** What pi did with a steering message (pi 0.99+). */
export type QueuedInputDisposition = 'queued' | 'handled'

/** Why the pi child is gone, once it is. */
export type PiExit = {
  code: number | null
  signal: NodeJS.Signals | null
  stderrTail: string
}

/** Maximum wait for an auxiliary context-usage update. */
export const SESSION_STATS_TIMEOUT_MS = 1_000

/** How much of pi's stderr to keep for an exit report. */
const STDERR_TAIL_BYTES = 4 * 1024

/**
 * How long an exit waits for pi's stdout/stderr to close before it is reported.
 * A process that exited can still have its last response and its dying words
 * in the pipes; a grandchild that inherited them must not hide the exit.
 */
const EXIT_DRAIN_MS = 250

/**
 * Shape of `stats.contextUsage` in pi's `get_session_stats` response.
 * `tokens` is null while pi has no trustworthy token count (e.g. right after compaction).
 */
export type PiContextUsage = {
  tokens?: number | null
  contextWindow?: number | null
}

export type PiSessionStats = {
  sessionId?: string
  sessionFile?: string
  totalMessages?: number
  cost?: number
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
  contextUsage?: PiContextUsage | null
}

export type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
  /** Extensions to load explicitly (`-e <path>`), e.g. the MCP bridge. */
  extensions?: string[]
  /** Extra environment for the pi child only. */
  env?: Record<string, string>
}

function dispositionOf<T extends string>(data: unknown, allowed: readonly T[]): T | undefined {
  const value = data && typeof data === 'object' ? (data as { disposition?: unknown }).disposition : undefined
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private exitHandlers: Array<(exit: PiExit) => void> = []
  private readonly preludeLines: string[] = []
  private stderrTail = ''
  private exitInfo: PiExit | null = null

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child

    // pi frames RPC records with LF only. Node's `readline` also splits on
    // U+2028/U+2029, which are legal inside JSON strings, so a model reply that
    // contains one would tear a record in two and lose it (see pi's rpc.md).
    const splitter = new JsonlSplitter(line => this.handleLine(line))
    child.stdout.on('data', (chunk: Buffer) => splitter.push(chunk))
    child.stdout.on('end', () => splitter.end())

    child.stderr.on('data', (chunk: Buffer) => {
      // Pass pi's diagnostics through: the ACP client captures this process's
      // stderr, and it is the only place a pi crash explains itself.
      try {
        process.stderr.write(chunk)
      } catch {
        // ignore
      }
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    })

    const reportExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.exitInfo) return
      this.exitInfo = { code, signal, stderrTail: this.stderrTail }
      const err = new Error(`pi process exited (code=${code}, signal=${signal})`)
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
      for (const h of this.exitHandlers) {
        try {
          h(this.exitInfo)
        } catch {
          // ignore
        }
      }
    }
    // A write to a pi that exited fails with EPIPE: `writeLine` reports it to
    // its request, and an unhandled stream error would take this process down.
    child.stdin.on('error', () => {})

    child.on('exit', (code, signal) => {
      // Let the pipes drain first: `close` comes once they did.
      const timer = setTimeout(() => reportExit(code, signal), EXIT_DRAIN_MS)
      child.once('close', () => {
        clearTimeout(timer)
        reportExit(code, signal)
      })
    })

    child.on('error', err => {
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      // pi may emit a human-readable prelude on stdout before NDJSON starts.
      const cleaned = stripAnsi(String(line)).trimEnd()
      if (cleaned) this.preludeLines.push(cleaned)
      return
    }

    if (msg?.type === 'response') {
      const id = typeof msg.id === 'string' ? msg.id : undefined
      // `resolve` removes the pending entry. Responses for unknown or already timed-out
      // ids are dropped: a response is never a pi event, so it must not be broadcast.
      if (id !== undefined) this.pending.get(id)?.resolve(msg as PiRpcResponse)
      return
    }

    for (const h of [...this.eventHandlers]) h(msg as PiRpcEvent)
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Themes are irrelevant in rpc mode and can be noisy/slow to load. Extensions
    // and prompt templates stay enabled: ACP users rely on them.
    const args = ['--mode', 'rpc', '--no-themes']
    if (params.sessionPath) args.push('--session', params.sessionPath)
    for (const extension of params.extensions ?? []) args.push('-e', extension)

    // Windows cmd launchers need shell escaping; direct executables use native argv.
    const start = shouldUseShellForPiCommand(cmd) ? crossSpawn : spawn
    const child = start(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: { ...process.env, ...(params.env ?? {}) }
    }) as ChildProcessWithoutNullStreams

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    const proc = new PiRpcProcess(child)

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await proc.getState()) as any
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch {
      // ignore for now
    }

    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  /** Subscribe to the child's exit. Fires at most once; immediately if it already exited. */
  onExit(handler: (exit: PiExit) => void): () => void {
    if (this.exitInfo) {
      handler(this.exitInfo)
      return () => {}
    }
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  /** Set once the child exited. */
  get exited(): PiExit | null {
    return this.exitInfo
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.killed || this.exitInfo) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  /**
   * Submit a prompt. Resolves with pi's disposition once pi accepted it; a
   * `handled` prompt starts no run (pi 0.99+). Older pi resolves `undefined`.
   */
  async prompt(message: string, images: unknown[] = []): Promise<PromptDisposition | undefined> {
    const res = await this.request({ type: 'prompt', message, images })
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
    return dispositionOf(res.data, ['started', 'queued', 'handled'] as const)
  }

  /** Queue a steering message into the running agent loop. */
  async steer(message: string, images: PiImagePayload[] | unknown[] = []): Promise<QueuedInputDisposition | undefined> {
    const res = await this.request({ type: 'steer', message, images })
    if (!res.success) throw new Error(`pi steer failed: ${res.error ?? JSON.stringify(res.data)}`)
    return dispositionOf(res.data, ['queued', 'handled'] as const)
  }

  /** Remove queued steering/follow-up messages; returns their text. */
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    const res = await this.request({ type: 'clear_queue' })
    if (!res.success) throw new Error(`pi clear_queue failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = (res.data ?? {}) as { steering?: unknown; followUp?: unknown }
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
    return {
      steering: strings(data.steering),
      followUp: strings(data.followUp)
    }
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    const res = await this.request({ type: 'get_available_thinking_levels' })
    if (!res.success)
      throw new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data
    const levels = data && typeof data === 'object' && 'levels' in data ? data.levels : undefined
    if (
      !Array.isArray(levels) ||
      levels.length === 0 ||
      !levels.every(level => typeof level === 'string' && level.length > 0)
    ) {
      throw new Error('pi get_available_thinking_levels returned invalid levels')
    }
    return levels
  }

  async setThinkingLevel(level: string): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions })
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(timeoutMs?: number): Promise<PiSessionStats> {
    const res = await this.request({ type: 'get_session_stats' }, { timeoutMs })
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return (res.data ?? {}) as PiSessionStats
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(cmd: PiRpcCommand, opts?: { timeoutMs?: number }): Promise<PiRpcResponse> {
    if (this.exitInfo) {
      return Promise.reject(new Error(`pi process exited (code=${this.exitInfo.code}, signal=${this.exitInfo.signal})`))
    }

    const id = crypto.randomUUID()
    const withId = { ...cmd, id }
    const timeoutMs = opts?.timeoutMs

    const line = `${JSON.stringify(withId)}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      // Returns false when the id was already dropped (e.g. by the timeout), so the
      // caller can avoid settling the promise twice.
      const drop = (): boolean => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        return this.pending.delete(id)
      }

      this.pending.set(id, {
        resolve: res => {
          drop()
          resolve(res)
        },
        reject: error => {
          drop()
          reject(error)
        }
      })

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timer = undefined
          if (!this.pending.delete(id)) return
          reject(new Error(`pi ${cmd.type} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        // Never let an auxiliary request keep the event loop alive.
        timer.unref?.()
      }

      void this.writeLine(line).catch(error => {
        if (!drop()) return
        reject(error)
      })
    })
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.child.stdin.write(line, error => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      } catch (error: unknown) {
        reject(error)
      }
    })
  }
}
