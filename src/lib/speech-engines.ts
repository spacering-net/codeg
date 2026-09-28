export const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
]

// The DOM lib shipped with TypeScript has no Web Speech API types.
export interface RecognitionAlternativeLike {
  transcript: string
}
export interface RecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: RecognitionAlternativeLike
}
export interface RecognitionEventLike {
  resultIndex: number
  results: ArrayLike<RecognitionResultLike>
}
export interface RecognitionLike {
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
export type RecognitionCtor = new () => RecognitionLike

export function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null
  const win = window as unknown as Record<string, unknown>
  const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition
  return typeof ctor === "function" ? (ctor as RecognitionCtor) : null
}

export function pickRecorderMimeType(): string | undefined {
  const isTypeSupported = MediaRecorder.isTypeSupported
  if (typeof isTypeSupported !== "function") return undefined
  return RECORDER_MIME_TYPES.find((type) =>
    isTypeSupported.call(MediaRecorder, type)
  )
}

export function blobToBase64(blob: Blob): Promise<string> {
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
