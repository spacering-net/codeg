"use client"

import { useEffect, useRef } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  useAcpActions,
  useAcpEvent,
  useConnectionStore,
} from "@/contexts/acp-connections-context"
import {
  assistantGetSettings,
  openSettingsWindow,
  speechGetSettings,
} from "@/lib/api"
import {
  detectSpeechCapabilities,
  resolveInputEngine,
  resolveOutputEngine,
  resolveSpeechLanguage,
  waitForVoices,
} from "@/lib/speech-capabilities"
import {
  beginSpeechStream,
  endSpeechStream,
  enqueueSpeech,
  onSpeechDrained,
  stopSpeech,
  type SpeakOptions,
} from "@/lib/speech-player"
import { getSpeechPrefs, useSpeechPrefs } from "@/lib/speech-prefs"
import type { EventEnvelope } from "@/lib/types"
import { useAssistantSession } from "@/lib/voice-mode/assistant-session"
import {
  startAudioFrontend,
  type AudioFrontend,
} from "@/lib/voice-mode/audio-frontend"
import { createSentenceStream } from "@/lib/voice-mode/sentence-stream"
import {
  createUtteranceRecorder,
  type UtteranceRecorder,
} from "@/lib/voice-mode/utterance-recorder"
import { createVad, type VadEvent, type VadState } from "@/lib/voice-mode/vad"
import { matchVoiceCommand } from "@/lib/voice-mode/voice-commands"

import { VoiceAnnouncer } from "./voice-announcer"
import { VoiceOrb } from "./voice-orb"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import {
  getVoiceModeState,
  patchVoiceMode,
  requestVoiceMode,
  resetVoiceMode,
  setVoiceLevel,
  setVoiceModeController,
  setVoicePhase,
  subscribeVoiceMode,
  type VoiceModeState,
} from "@/lib/voice-mode/voice-mode-store"

const DEBUG_FLAG = "codeg:voice-debug"
const DEBUG_LOG_LIMIT = 200

export interface VoiceModeHostProps {
  matchCommand?: (text: string) => boolean
}

interface Turn {
  id: string
  stream: ReturnType<typeof createSentenceStream> | null
  spoken: string[]
  complete: boolean
}

interface VoiceDebug {
  readonly state: VoiceModeState & { spoken: string[]; log: string[] }
  inject(text: string): boolean
  request(on: boolean): void
}

declare global {
  interface Window {
    __codegVoiceDebug?: VoiceDebug
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

const noCommand = () => false

// codeg's assistant confirmation cards (assistant_tools.rs) always use this
// header; the agent's own ask_user_question must never be answered by voice.
const ASSISTANT_CONFIRM_HEADER = "Confirm"

export function VoiceModeHost({
  matchCommand = noCommand,
}: VoiceModeHostProps) {
  const t = useTranslations("VoiceMode")
  const tMessages = useTranslations("Folder.chat.messageList")
  const locale = useLocale()
  const announce = useSpeechPrefs().voiceMode.announce
  const { shortcuts } = useShortcutSettings()
  const connections = useConnectionStore()
  const assistant = useAssistantSession()
  const { cancel, answerQuestion } = useAcpActions()

  const runRef = useRef(0)
  const frontendRef = useRef<AudioFrontend | null>(null)
  const vadRef = useRef<VadState | null>(null)
  const recorderRef = useRef<UtteranceRecorder | null>(null)
  const speakRef = useRef<SpeakOptions | null>(null)
  const turnRef = useRef<Turn | null>(null)
  const inFlightRef = useRef(false)
  const debugRef = useRef<{ spoken: string[]; log: string[] } | null>(null)

  const log = (entry: string) => {
    const debug = debugRef.current
    if (!debug) return
    debug.log.push(entry)
    if (debug.log.length > DEBUG_LOG_LIMIT) debug.log.shift()
  }

  const settleAfterUtterance = () => {
    const turn = turnRef.current
    if (!turn) setVoicePhase("listening")
    else setVoicePhase(turn.spoken.length > 0 ? "speaking" : "waiting")
  }

  const send = (text: string) => {
    const session = getVoiceModeState().assistant
    const options = speakRef.current
    if (!session || !options) return
    const id = `voice-turn-${Date.now()}`
    turnRef.current = {
      id,
      stream: createSentenceStream(options.labels),
      spoken: [],
      complete: false,
    }
    inFlightRef.current = true
    patchVoiceMode({ queued: null })
    beginSpeechStream(id, options)
    setVoicePhase("waiting")
    log(`send:${text}`)
    assistant.send(text).catch((error: unknown) => {
      if (turnRef.current?.id === id) {
        turnRef.current = null
        inFlightRef.current = false
        stopSpeech()
        setVoicePhase("listening")
      }
      toast.error(t("sendFailed", { message: String(error) }))
    })
  }

  const submit = (text: string) => {
    const session = getVoiceModeState().assistant
    if (!session) return
    const prompting =
      inFlightRef.current ||
      connections.getConnection(session.connectionId)?.status === "prompting"
    if (prompting) {
      patchVoiceMode({ queued: text })
      toast(t("queued"))
      log(`queued:${text}`)
      settleAfterUtterance()
      return
    }
    send(text)
  }

  const speakNotice = (text: string) => {
    const options = speakRef.current
    if (!options) return
    debugRef.current?.spoken.push(text)
    log(`speak:${text}`)
    // A notice during a live reply (a confirmation card arrives mid-turn)
    // restarts that turn's stream so the rest of the reply is still spoken.
    const live = turnRef.current
    if (live && !live.complete) {
      live.spoken.push(text)
      beginSpeechStream(live.id, options)
      enqueueSpeech(live.id, text)
      return
    }
    const id = `voice-notice-${Date.now()}`
    turnRef.current = {
      id,
      stream: null,
      spoken: [text],
      complete: true,
    }
    beginSpeechStream(id, options)
    enqueueSpeech(id, text)
    endSpeechStream(id)
  }

  const phaseAfterConfirmation = () =>
    turnRef.current && !turnRef.current.complete ? "waiting" : "listening"

  const handleTranscript = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) {
      settleAfterUtterance()
      return
    }
    log(`heard:${trimmed}`)
    if (matchCommand(trimmed)) return

    const { assistant: session } = getVoiceModeState()
    const conn = session
      ? connections.getConnection(session.connectionId)
      : null
    const pq = conn?.pendingAskQuestion

    let isConfirming = false
    if (pq) {
      const q = pq.questions[0]
      isConfirming =
        pq.questions.length === 1 &&
        q.options.length === 2 &&
        q.header === ASSISTANT_CONFIRM_HEADER
    }

    const matchPhase = isConfirming ? "confirming" : getVoiceModeState().phase

    const phrases = {
      stop: t("commands.stop"),
      cancel: t("commands.cancel"),
      repeat: t("commands.repeat"),
      exit: t("commands.exit"),
      confirm: t("commands.confirm"),
      reject: t("commands.reject"),
    }
    const cmd = matchVoiceCommand(trimmed, phrases, matchPhase)

    if (cmd === "stop") {
      stopSpeech()
      settleAfterUtterance()
      return
    }
    if (cmd === "cancel") {
      if (session) void cancel(session.connectionId)
      stopSpeech()
      settleAfterUtterance()
      return
    }
    if (cmd === "repeat") {
      const { lastSpoken } = getVoiceModeState()
      if (lastSpoken) speakNotice(lastSpoken)
      else settleAfterUtterance()
      return
    }
    if (cmd === "exit") {
      stop()
      return
    }

    if (isConfirming && session && pq) {
      if (cmd === "confirm" || cmd === "reject") {
        const q = pq.questions[0]
        const label =
          cmd === "confirm" ? q.options[0].label : q.options[1].label
        void answerQuestion(session.connectionId, pq.question_id, {
          answers: [{ questionId: q.id, labels: [label] }],
          declined: false,
        })
        setVoicePhase(phaseAfterConfirmation())
        return
      }
      nonMatchCountRef.current += 1
      if (nonMatchCountRef.current >= 2) {
        speakNotice(t("confirmUseScreen"))
        setVoicePhase("listening")
      } else {
        speakNotice(t("confirmRepeat"))
        setVoicePhase("confirming")
      }
      return
    }

    submit(trimmed)
  }

  const onVadEvent = (event: VadEvent) => {
    const recorder = recorderRef.current
    const phase = getVoiceModeState().phase
    if (!recorder || phase === "off" || phase === "starting") return
    const replying = phase === "waiting" || phase === "speaking"
    if (replying && !getSpeechPrefs().voiceMode.bargeIn) return
    switch (event) {
      case "speech-candidate":
        recorder.beginUtterance()
        break
      case "candidate-dropped":
        recorder.abort()
        break
      case "speech-start":
        if (replying) {
          stopSpeech()
          turnRef.current = null
          log("barge-in")
        }
        setVoicePhase("capturing")
        break
      case "speech-end":
        setVoicePhase("transcribing")
        recorder.endUtterance().then(handleTranscript, (error: unknown) => {
          toast.error(t("transcribeFailed", { message: String(error) }))
          settleAfterUtterance()
        })
        break
    }
  }

  const stop = () => {
    runRef.current += 1
    const frontend = frontendRef.current
    frontendRef.current = null
    vadRef.current = null
    recorderRef.current?.abort()
    recorderRef.current = null
    turnRef.current = null
    inFlightRef.current = false
    stopSpeech()
    if (frontend) void frontend.stop()
    assistant.release()
    resetVoiceMode()
    log("exit")
  }

  const refuse = (message: string) => {
    toast.error(message, {
      action: {
        label: t("openSpeechSettings"),
        onClick: () => void openSettingsWindow("speech"),
      },
    })
  }

  const start = async () => {
    const run = ++runRef.current
    const stale = () => run !== runRef.current
    const prefs = getSpeechPrefs()
    const [speech, settings] = await Promise.all([
      speechGetSettings(),
      assistantGetSettings(),
    ])
    const input = resolveInputEngine(
      prefs.input,
      detectSpeechCapabilities(),
      speech.apiKeySet
    )
    const voices = prefs.output.engine === "cloud" ? [] : await waitForVoices()
    const output = resolveOutputEngine(
      prefs.output,
      { browserTts: voices.length > 0 },
      speech.apiKeySet
    )
    if (stale()) return
    if (input.engine === null) return refuse(t("inputUnavailable"))
    if (output.engine === null) return refuse(t("outputUnavailable"))
    if (!settings.agentType) return refuse(t("noAssistantAgent"))

    stopSpeech()
    setVoicePhase("starting")
    patchVoiceMode({ error: null })
    const language = resolveSpeechLanguage(prefs.input, locale)
    speakRef.current = {
      engine: output.engine,
      language,
      labels: {
        codeOmitted: tMessages("speechCodeOmitted"),
        tableOmitted: tMessages("speechTableOmitted"),
      },
    }
    try {
      const session = await assistant.ensure()
      if (stale()) return assistant.release()
      patchVoiceMode({ assistant: session })
      const vad = createVad({ endSilenceMs: prefs.voiceMode.endSilenceMs })
      const frontend = await startAudioFrontend({
        onLevel: setVoiceLevel,
        onVadEvent: (event) => onVadEventRef.current(event),
        vad,
      })
      if (stale()) {
        void frontend.stop()
        return
      }
      frontendRef.current = frontend
      vadRef.current = vad
      recorderRef.current = createUtteranceRecorder(
        input.engine,
        frontend.stream,
        language
      )
      setVoicePhase("listening")
      log("listening")
    } catch (error) {
      if (stale()) return
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t("startFailed", { message }))
      stop()
      patchVoiceMode({ error: message })
    }
  }

  const nonMatchCountRef = useRef(0)
  const lastQuestionIdRef = useRef("")

  useEffect(() => {
    let unmounted = false
    let connUnsubscribe: (() => void) | null = null
    let currentConnId = ""

    const checkAssistant = () => {
      if (unmounted) return
      const session = getVoiceModeState().assistant
      const connId = session?.connectionId ?? ""
      if (connId === currentConnId) return

      if (connUnsubscribe) connUnsubscribe()
      currentConnId = connId

      if (connId) {
        connUnsubscribe = connections.subscribeKey(connId, () => {
          const conn = connections.getConnection(connId)
          if (!conn) return
          const pq = conn.pendingAskQuestion
          if (!pq) {
            lastQuestionIdRef.current = ""
            nonMatchCountRef.current = 0
            if (getVoiceModeState().phase === "confirming") {
              setVoicePhase(handlersRef.current.phaseAfterConfirmation())
            }
            return
          }
          if (pq.question_id === lastQuestionIdRef.current) return
          lastQuestionIdRef.current = pq.question_id
          nonMatchCountRef.current = 0

          const q = pq.questions[0]
          const isConfirm =
            pq.questions.length === 1 &&
            q.options.length === 2 &&
            q.header === ASSISTANT_CONFIRM_HEADER

          if (isConfirm) {
            stopSpeech()
            setVoicePhase("confirming")
            handlersRef.current.speakNotice(
              t("confirmPrompt", { action: q.question.slice(0, 200) })
            )
          } else {
            handlersRef.current.speakNotice(
              t("questionOnScreen", { question: q.question })
            )
          }
        })
      } else {
        connUnsubscribe = null
      }
    }

    const unsubVoice = subscribeVoiceMode(checkAssistant)
    checkAssistant()

    return () => {
      unmounted = true
      unsubVoice()
      if (connUnsubscribe) connUnsubscribe()
    }
  }, [connections, t])

  const onVadEventRef = useRef(onVadEvent)
  const handlersRef = useRef({
    start,
    stop,
    send,
    log,
    speakNotice,
    phaseAfterConfirmation,
  })
  useEffect(() => {
    onVadEventRef.current = onVadEvent
    handlersRef.current = {
      start,
      stop,
      send,
      log,
      speakNotice,
      phaseAfterConfirmation,
    }
  })

  useAcpEvent((envelope: EventEnvelope) => {
    const session = getVoiceModeState().assistant
    if (!session || envelope.connection_id !== session.connectionId) return
    const turn = turnRef.current
    if (envelope.type === "content_delta") {
      if (!turn?.stream || envelope.parent_tool_use_id) return
      for (const segment of turn.stream.push(envelope.text)) {
        turn.spoken.push(segment)
        debugRef.current?.spoken.push(segment)
        enqueueSpeech(turn.id, segment)
      }
      if (turn.spoken.length > 0 && getVoiceModeState().phase === "waiting") {
        setVoicePhase("speaking")
      }
      return
    }
    if (envelope.type !== "turn_complete") return
    inFlightRef.current = false
    log(`turn_complete:${envelope.stop_reason}`)
    if (turn?.stream) {
      for (const segment of turn.stream.flush()) {
        turn.spoken.push(segment)
        debugRef.current?.spoken.push(segment)
        enqueueSpeech(turn.id, segment)
      }
      if (turn.spoken.length === 0 && envelope.stop_reason !== "end_turn") {
        const notice = t("voiceTurnEndedEmpty")
        turn.spoken.push(notice)
        debugRef.current?.spoken.push(notice)
        enqueueSpeech(turn.id, notice)
      }
      turn.complete = true
      endSpeechStream(turn.id)
      return
    }
    const { queued } = getVoiceModeState()
    if (queued) send(queued)
  })

  useEffect(() => {
    const unsubscribeDrain = onSpeechDrained(() => {
      const turn = turnRef.current
      if (!turn?.complete) return
      turnRef.current = null
      patchVoiceMode({ lastSpoken: turn.spoken.join(" ") || null })
      handlersRef.current.log("drained")
      const { queued, phase } = getVoiceModeState()
      if (queued) handlersRef.current.send(queued)
      else if (phase === "waiting" || phase === "speaking") {
        setVoicePhase("listening")
      }
    })
    const unsubscribePhase = subscribeVoiceMode(() => {
      const { phase } = getVoiceModeState()
      vadRef.current?.setPlaybackActive(
        phase === "waiting" || phase === "speaking"
      )
    })
    setVoiceModeController({
      start: () => void handlersRef.current.start(),
      stop: () => handlersRef.current.stop(),
    })
    return () => {
      unsubscribeDrain()
      unsubscribePhase()
      setVoiceModeController(null)
      if (getVoiceModeState().phase !== "off") handlersRef.current.stop()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchShortcutEvent(event, shortcuts.toggle_voice_mode)) {
        event.preventDefault()
        const { phase } = getVoiceModeState()
        requestVoiceMode(phase === "off")
        return
      }
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      if (getVoiceModeState().phase === "off") return
      handlersRef.current.stop()
    }
    const onPageHide = () => {
      if (getVoiceModeState().phase !== "off") handlersRef.current.stop()
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("pagehide", onPageHide)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("pagehide", onPageHide)
    }
  }, [shortcuts])

  const injectRef = useRef(handleTranscript)
  useEffect(() => {
    injectRef.current = handleTranscript
  })
  useEffect(() => {
    if (window.localStorage.getItem(DEBUG_FLAG) !== "1") return
    const debug = { spoken: [], log: [] }
    debugRef.current = debug
    window.__codegVoiceDebug = {
      get state() {
        return { ...getVoiceModeState(), ...debug }
      },
      inject(text: string) {
        const { phase } = getVoiceModeState()
        if (phase === "off" || phase === "starting") return false
        injectRef.current(text)
        return true
      },
      request: requestVoiceMode,
    }
    return () => {
      debugRef.current = null
      delete window.__codegVoiceDebug
    }
  }, [])

  return (
    <>
      <VoiceAnnouncer
        announce={announce}
        speak={(text) => handlersRef.current.speakNotice(text)}
      />
      <VoiceOrb />
    </>
  )
}
