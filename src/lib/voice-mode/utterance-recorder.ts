import { speechTranscribe } from "@/lib/api"
import {
  blobToBase64,
  pickRecorderMimeType,
  recognitionCtor,
  type RecognitionLike,
} from "@/lib/speech-engines"

export const MAX_UTTERANCE_MS = 60_000

export interface UtteranceRecorder {
  beginUtterance(): void
  /** Resolves with the utterance text, or "" when nothing was captured. */
  endUtterance(): Promise<string>
  /** Discards the utterance; nothing is transcribed or sent. */
  abort(): void
}

export function createUtteranceRecorder(
  engine: "browser" | "cloud",
  stream: MediaStream,
  language: string
): UtteranceRecorder {
  return engine === "browser"
    ? createBrowserRecorder(language)
    : createCloudRecorder(stream, language)
}

function createBrowserRecorder(language: string): UtteranceRecorder {
  let recognition: RecognitionLike | null = null
  let finals = ""
  let interim = ""

  const release = () => {
    if (!recognition) return
    const current = recognition
    recognition = null
    current.onresult = null
    current.onerror = null
    current.onend = null
    current.abort()
  }

  return {
    beginUtterance() {
      if (recognition) return
      const Ctor = recognitionCtor()
      if (!Ctor) return
      finals = ""
      interim = ""
      const next = new Ctor()
      next.continuous = true
      next.interimResults = true
      next.lang = language
      next.onresult = (event) => {
        let pending = ""
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          const transcript = result[0]?.transcript ?? ""
          if (result.isFinal) finals += transcript
          else pending += transcript
        }
        interim = pending
      }
      recognition = next
      try {
        next.start()
      } catch {
        release()
      }
    },
    endUtterance() {
      const text = recognition ? `${finals}${interim}`.trim() : ""
      release()
      return Promise.resolve(text)
    },
    abort: release,
  }
}

function createCloudRecorder(
  stream: MediaStream,
  language: string
): UtteranceRecorder {
  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let onStopped: (() => void) | null = null

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  return {
    beginUtterance() {
      if (recorder) return
      chunks = []
      const preferred = pickRecorderMimeType()
      const next = preferred
        ? new MediaRecorder(stream, { mimeType: preferred })
        : new MediaRecorder(stream)
      next.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      next.onstop = () => onStopped?.()
      recorder = next
      // The cap only stops capture; the utterance is still transcribed when
      // the host calls endUtterance.
      timer = setTimeout(() => {
        if (next.state !== "inactive") next.stop()
      }, MAX_UTTERANCE_MS)
      next.start()
    },
    endUtterance() {
      const current = recorder
      if (!current) return Promise.resolve("")
      recorder = null
      clearTimer()
      const mimeType = (current.mimeType || "audio/webm").split(";")[0].trim()
      const collect = new Promise<Blob>((resolve) => {
        const finish = () => {
          onStopped = null
          resolve(new Blob(chunks, { type: mimeType }))
        }
        if (current.state === "inactive") finish()
        else {
          onStopped = finish
          current.stop()
        }
      })
      return collect.then(async (blob) => {
        if (blob.size === 0) return ""
        const base64 = await blobToBase64(blob)
        const text = await speechTranscribe(base64, mimeType, language || null)
        return text.trim()
      })
    },
    abort() {
      clearTimer()
      const current = recorder
      recorder = null
      onStopped = null
      chunks = []
      if (!current) return
      current.ondataavailable = null
      current.onstop = null
      if (current.state !== "inactive") current.stop()
    },
  }
}
