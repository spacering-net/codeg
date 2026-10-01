"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useLocale } from "next-intl"

import { speechGetSettings, speechTranscribe } from "@/lib/api"
import { extractAppCommandError } from "@/lib/app-error"
import {
  detectSpeechCapabilities,
  resolveInputEngine,
  resolveSpeechLanguage,
  type InputEngineResolution,
  type SpeechCapabilities,
} from "@/lib/speech-capabilities"
import { useSpeechPrefs } from "@/lib/speech-prefs"

export type SpeechInputStatus =
  | "idle"
  | "listening"
  | "transcribing"
  | "unavailable"

export type SpeechInputError =
  | "mic-denied"
  | "engine-failed"
  | "cloud-auth"
  | "cloud-not-configured"

export type SpeechUnavailableReason = Extract<
  InputEngineResolution,
  { engine: null }
>["reason"]

export interface UseSpeechInputOptions {
  onFinalText: (text: string) => void
  onError: (error: SpeechInputError) => void
}

export interface UseSpeechInputResult {
  status: SpeechInputStatus
  interimText: string
  unavailableReason: SpeechUnavailableReason | null
  start: () => void
  stop: () => void
  cancel: () => void
  toggle: () => void
}

export const MAX_RECORDING_MS = 120_000

const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
]

// The DOM lib shipped with TypeScript has no Web Speech API types.
interface RecognitionAlternativeLike {
  transcript: string
}
interface RecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: RecognitionAlternativeLike
}
interface RecognitionEventLike {
  resultIndex: number
  results: ArrayLike<RecognitionResultLike>
}
interface RecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: RecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionCtor = new () => RecognitionLike

const subscribeNever = () => () => {}
const onClient = () => true
const onServer = () => false

type Session =
  | { kind: "browser"; recognition: RecognitionLike }
  | {
      kind: "cloud"
      stream: MediaStream
      recorder: MediaRecorder
      chunks: Blob[]
      mimeType: string
      language: string
      timer: ReturnType<typeof setTimeout>
    }

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null
  const win = window as unknown as Record<string, unknown>
  const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition
  return typeof ctor === "function" ? (ctor as RecognitionCtor) : null
}

function pickRecorderMimeType(): string | undefined {
  const isTypeSupported = MediaRecorder.isTypeSupported
  if (typeof isTypeSupported !== "function") return undefined
  return RECORDER_MIME_TYPES.find((type) =>
    isTypeSupported.call(MediaRecorder, type)
  )
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "")
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function releaseSession(session: Session) {
  if (session.kind === "browser") {
    const { recognition } = session
    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
    recognition.abort()
    return
  }
  clearTimeout(session.timer)
  session.recorder.ondataavailable = null
  session.recorder.onstop = null
  if (session.recorder.state !== "inactive") session.recorder.stop()
  session.stream.getTracks().forEach((track) => track.stop())
}

function cloudErrorFromException(error: unknown): SpeechInputError {
  switch (extractAppCommandError(error)?.code) {
    case "authentication_failed":
      return "cloud-auth"
    case "configuration_missing":
      return "cloud-not-configured"
    default:
      return "engine-failed"
  }
}

function micErrorFromException(error: unknown): SpeechInputError {
  const name = error instanceof Error ? error.name : ""
  return name === "NotAllowedError" || name === "SecurityError"
    ? "mic-denied"
    : "engine-failed"
}

export function useSpeechInput({
  onFinalText,
  onError,
}: UseSpeechInputOptions): UseSpeechInputResult {
  const prefs = useSpeechPrefs()
  const locale = useLocale()
  const language = resolveSpeechLanguage(prefs.input, locale)

  const [activeStatus, setActiveStatus] = useState<
    "idle" | "listening" | "transcribing"
  >("idle")
  const [interimText, setInterimText] = useState("")
  // Both are read from the browser, so they stay unknown until mount to keep
  // the prerendered markup identical to the first client render.
  const mounted = useSyncExternalStore(subscribeNever, onClient, onServer)
  const caps = useMemo<SpeechCapabilities | null>(
    () => (mounted ? detectSpeechCapabilities() : null),
    [mounted]
  )
  const [apiKeySet, setApiKeySet] = useState<boolean | null>(null)

  const sessionRef = useRef<Session | null>(null)
  // Bumped by every start, cancel and unmount; an async step that finds a
  // different value belongs to a session that no longer exists.
  const generationRef = useRef(0)
  const busyRef = useRef(false)
  const callbacksRef = useRef({ onFinalText, onError })
  const contextRef = useRef({ prefs, language, apiKeySet })

  useEffect(() => {
    callbacksRef.current = { onFinalText, onError }
  }, [onFinalText, onError])

  useEffect(() => {
    contextRef.current = { prefs, language, apiKeySet }
  }, [prefs, language, apiKeySet])

  const refreshSettings = useCallback(async (): Promise<boolean> => {
    try {
      const view = await speechGetSettings()
      setApiKeySet(view.apiKeySet)
      return view.apiKeySet
    } catch {
      setApiKeySet(false)
      return false
    }
  }, [])

  useEffect(() => {
    let alive = true
    speechGetSettings().then(
      (view) => {
        if (alive) setApiKeySet(view.apiKeySet)
      },
      () => {
        if (alive) setApiKeySet(false)
      }
    )
    return () => {
      alive = false
    }
  }, [])

  // A key saved in the (separate) settings window is noticed on refocus.
  useEffect(() => {
    if (apiKeySet !== false) return
    const onFocus = () => void refreshSettings()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [apiKeySet, refreshSettings])

  const finish = useCallback((generation: number) => {
    if (generation !== generationRef.current) return
    sessionRef.current = null
    busyRef.current = false
    setInterimText("")
    setActiveStatus("idle")
  }, [])

  const fail = useCallback(
    (generation: number, error: SpeechInputError) => {
      if (generation !== generationRef.current) return
      const session = sessionRef.current
      if (session) releaseSession(session)
      finish(generation)
      callbacksRef.current.onError(error)
    },
    [finish]
  )

  const startBrowser = useCallback(
    (generation: number, lang: string) => {
      const Ctor = recognitionCtor()
      if (!Ctor) {
        fail(generation, "engine-failed")
        return
      }
      const recognition = new Ctor()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = lang
      recognition.onresult = (event) => {
        if (generation !== generationRef.current) return
        let interim = ""
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i]
          const transcript = result[0]?.transcript ?? ""
          if (result.isFinal) {
            const text = transcript.trim()
            if (text) callbacksRef.current.onFinalText(text)
          } else {
            interim += transcript
          }
        }
        setInterimText(interim.trim())
      }
      recognition.onerror = (event) => {
        if (event.error === "aborted" || event.error === "no-speech") return
        fail(
          generation,
          event.error === "not-allowed" || event.error === "service-not-allowed"
            ? "mic-denied"
            : "engine-failed"
        )
      }
      recognition.onend = () => finish(generation)
      sessionRef.current = { kind: "browser", recognition }
      try {
        recognition.start()
      } catch {
        fail(generation, "engine-failed")
        return
      }
      setActiveStatus("listening")
    },
    [fail, finish]
  )

  const transcribe = useCallback(
    async (generation: number, blob: Blob, mimeType: string, lang: string) => {
      try {
        const audio = await blobToBase64(blob)
        if (generation !== generationRef.current) return
        const text = (await speechTranscribe(audio, mimeType, lang)).trim()
        if (generation !== generationRef.current) return
        if (text) callbacksRef.current.onFinalText(text)
        finish(generation)
      } catch (error) {
        fail(generation, cloudErrorFromException(error))
      }
    },
    [fail, finish]
  )

  const stopCloud = useCallback(
    (generation: number) => {
      const session = sessionRef.current
      if (generation !== generationRef.current || session?.kind !== "cloud") {
        return
      }
      if (session.recorder.state === "inactive") return
      clearTimeout(session.timer)
      session.recorder.onstop = () => {
        session.stream.getTracks().forEach((track) => track.stop())
        const blob = new Blob(session.chunks, { type: session.mimeType })
        if (blob.size === 0) {
          finish(generation)
          return
        }
        void transcribe(generation, blob, session.mimeType, session.language)
      }
      session.recorder.stop()
      setInterimText("")
      setActiveStatus("transcribing")
    },
    [finish, transcribe]
  )

  const startCloud = useCallback(
    async (generation: number, lang: string) => {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (error) {
        fail(generation, micErrorFromException(error))
        return
      }
      if (generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      let recorder: MediaRecorder
      try {
        const preferred = pickRecorderMimeType()
        recorder = preferred
          ? new MediaRecorder(stream, { mimeType: preferred })
          : new MediaRecorder(stream)
      } catch {
        stream.getTracks().forEach((track) => track.stop())
        fail(generation, "engine-failed")
        return
      }
      // The backend keys the upload's file extension off the bare type.
      const mimeType = (recorder.mimeType || "audio/webm").split(";")[0].trim()
      const chunks: Blob[] = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      const timer = setTimeout(() => stopCloud(generation), MAX_RECORDING_MS)
      sessionRef.current = {
        kind: "cloud",
        stream,
        recorder,
        chunks,
        mimeType,
        language: lang,
        timer,
      }
      recorder.start()
      setActiveStatus("listening")
    },
    [fail, stopCloud]
  )

  const start = useCallback(() => {
    if (busyRef.current) return
    busyRef.current = true
    generationRef.current += 1
    const generation = generationRef.current
    const {
      prefs: current,
      language: lang,
      apiKeySet: known,
    } = contextRef.current

    void (async () => {
      const configured = known === true ? true : await refreshSettings()
      if (generation !== generationRef.current) return
      const resolution = resolveInputEngine(
        current.input,
        detectSpeechCapabilities(),
        configured
      )
      if (resolution.engine === null) {
        finish(generation)
        if (resolution.reason === "cloud-not-configured") {
          callbacksRef.current.onError("cloud-not-configured")
        }
      } else if (resolution.engine === "browser") {
        startBrowser(generation, lang)
      } else {
        await startCloud(generation, lang)
      }
    })()
  }, [finish, refreshSettings, startBrowser, startCloud])

  const stop = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    if (session.kind === "browser") {
      // `stop` (not `abort`) lets the engine deliver the last final result;
      // `onend` then releases the session.
      session.recognition.stop()
      return
    }
    stopCloud(generationRef.current)
  }, [stopCloud])

  const cancel = useCallback(() => {
    const generation = generationRef.current
    const session = sessionRef.current
    if (session) releaseSession(session)
    finish(generation)
    generationRef.current += 1
  }, [finish])

  const toggle = useCallback(() => {
    if (busyRef.current) stop()
    else start()
  }, [start, stop])

  useEffect(
    () => () => {
      generationRef.current += 1
      const session = sessionRef.current
      sessionRef.current = null
      if (session) releaseSession(session)
    },
    []
  )

  const unavailableReason = useMemo<SpeechUnavailableReason | null>(() => {
    if (!caps || apiKeySet === null) return null
    const resolution = resolveInputEngine(prefs.input, caps, apiKeySet)
    return resolution.engine === null ? resolution.reason : null
  }, [apiKeySet, caps, prefs.input])

  const status: SpeechInputStatus =
    activeStatus === "idle" && unavailableReason ? "unavailable" : activeStatus

  return {
    status,
    interimText,
    unavailableReason,
    start,
    stop,
    cancel,
    toggle,
  }
}
