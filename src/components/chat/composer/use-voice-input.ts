import { useCallback, useEffect, useRef, useState } from "react"

export type VoiceInputStatus = "idle" | "listening" | "transcribing" | "error"
export type VoiceInputMode = "web-speech" | "gemini" | "whisper"
export type VoiceInputEngine = "auto" | "gemini" | "web-speech" | "whisper"

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeString(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, "data")
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([view], { type: "audio/wav" })
}

export async function transcribeAudioWithGemini(
  wavBlob: Blob,
  endpoint = "http://127.0.0.1:8318/v1/chat/completions",
  apiKey = "YaoI3_nkcqDk4otG0S8b5xnpz9kJg6yVL3sjj-e6Tqg"
): Promise<string> {
  const base64Data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      const base64 = result.split(",")[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(wavBlob)
  })

  const payload = {
    model: "gemini-3.8-flash-high",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "你是一个高精度专业语音识别(ASR)引擎。请将这段音频逐字转写为纯文本。\n严格规则：\n" +
              "1. 仅输出转写后的文本内容，严禁包含任何解释、问候、代码块或前后缀；\n" +
              "2. 严格忠于原文发音。中文输出为规范汉字，英文术语与代码名词（如 Python, Git, PR, Bug, React, API, Token, Hook, TypeScript 等）如实保留标准英文与大小写；\n" +
              "3. 适当添加规范标点符号；\n" +
              "4. 若音频静音或无清晰人声，输出空字符串。"
          },
          {
            type: "input_audio",
            input_audio: {
              data: base64Data,
              format: "wav"
            }
          }
        ]
      }
    ],
    temperature: 0.1
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey
    },
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    throw new Error("Gemini ASR HTTP " + res.status)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() || ""
}

export interface UseVoiceInputOptions {
  /** Called when a speech segment is transcribed. */
  onTranscript?: (text: string, isFinal: boolean) => void
  /** Called with the real-time interim recognition text. */
  onInterimTranscript?: (text: string) => void
  /** Called when an error occurs during speech recognition. */
  onError?: (error: string) => void
  /** BCP 47 language tag (e.g. 'zh-CN', 'en-US'). Defaults to navigator.language. */
  lang?: string
  /** Voice recognition engine choice: 'gemini' (local 8318), 'web-speech', or 'whisper'. */
  engine?: VoiceInputEngine
  /** Optional Whisper/ASR transcription API endpoint (e.g. '/v1/audio/transcriptions'). */
  asrEndpoint?: string
  /** Optional API token for the ASR endpoint. */
  asrApiKey?: string
}

export interface UseVoiceInputReturn {
  status: VoiceInputStatus
  mode: VoiceInputMode
  isSupported: boolean
  volume: number
  interimText: string
  errorMessage: string | null
  startListening: () => Promise<void>
  stopListening: () => void
  cancel: () => void
}

export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const { onTranscript, onInterimTranscript, onError, lang, engine = "auto", asrEndpoint, asrApiKey } = options

  const [status, setStatus] = useState<VoiceInputStatus>("idle")
  const [mode, setMode] = useState<VoiceInputMode>("web-speech")
  const [volume, setVolume] = useState<number>(0)
  const [interimText, setInterimText] = useState<string>("")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const recognitionRef = useRef<any>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const pcmChunksRef = useRef<Float32Array[]>([])
  const processorRef = useRef<any>(null)
  const sampleRateRef = useRef<number>(16000)
  const audioContextRef = useRef<AudioContext | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Check if Web Speech API or MediaDevices is supported
  const isSupported = typeof window !== "undefined" && Boolean(
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) ||
    (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function")
  )

  const cleanupAudio = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }
    setVolume(0)
  }, [])

  const cancel = useCallback(() => {
    if (processorRef.current) {
      try {
        processorRef.current.disconnect()
      } catch {}
      processorRef.current = null
    }
    pcmChunksRef.current = []
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort()
      } catch {}
      recognitionRef.current = null
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop()
      } catch {}
      mediaRecorderRef.current = null
    }
    cleanupAudio()
    setInterimText("")
    setStatus("idle")
  }, [cleanupAudio])

  const startVolumeMeter = useCallback((stream: MediaStream) => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
      if (!AudioContextClass) return
      const audioCtx = new AudioContextClass()
      audioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const checkVolume = () => {
        if (!isMountedRef.current) return
        analyser.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i]
        }
        const avg = sum / dataArray.length
        const norm = Math.min(1, Math.max(0, avg / 80))
        setVolume(norm)
        animationFrameRef.current = requestAnimationFrame(checkVolume)
      }
      checkVolume()
    } catch (e) {
      console.warn("[useVoiceInput] Volume meter failed:", e)
    }
  }, [])

  const startListening = useCallback(async () => {
    setErrorMessage(null)
    setInterimText("")

    if (engine === "gemini" && typeof window !== "undefined" && navigator.mediaDevices?.getUserMedia) {
      setMode("gemini")
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        mediaStreamRef.current = stream
        startVolumeMeter(stream)

        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
        const audioCtx = new AudioContextClass()
        audioContextRef.current = audioCtx
        sampleRateRef.current = audioCtx.sampleRate || 16000

        const source = audioCtx.createMediaStreamSource(stream)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor
        pcmChunksRef.current = []

        processor.onaudioprocess = (e: any) => {
          if (!isMountedRef.current) return
          const input = e.inputBuffer.getChannelData(0)
          pcmChunksRef.current.push(new Float32Array(input))
        }

        source.connect(processor)
        processor.connect(audioCtx.destination)

        setStatus("listening")
        setInterimText("正在聆听中英文... 说完点击停止")
      } catch (err: any) {
        console.error("[useVoiceInput] Gemini ASR start failed:", err)
        const msg = err.name === "NotAllowedError" ? "micPermissionDenied" : err.message
        setErrorMessage(msg)
        onError?.(msg)
        setStatus("error")
        cleanupAudio()
      }
      return
    }

    const SpeechRecognitionClass = (typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null

    if (SpeechRecognitionClass && !asrEndpoint) {
      setMode("web-speech")
      try {
        if (navigator.mediaDevices?.getUserMedia) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            mediaStreamRef.current = stream
            startVolumeMeter(stream)
          } catch {}
        }

        const recognition = new SpeechRecognitionClass()
        recognitionRef.current = recognition
        recognition.continuous = true
        recognition.interimResults = true
        recognition.maxAlternatives = 1
        // Priority: explicit lang > app Chinese default > navigator.language
        recognition.lang = lang || "zh-CN"

        recognition.onresult = (event: any) => {
          let finalChunk = ""
          let currentInterim = ""

          for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript
            if (event.results[i].isFinal) {
              finalChunk += transcript
            } else {
              currentInterim += transcript
            }
          }

          if (finalChunk) {
            const cleaned = finalChunk.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, "$1$2")
            onTranscript?.(cleaned, true)
          }
          const cleanedInterim = currentInterim.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, "$1$2")
          setInterimText(cleanedInterim)
          onInterimTranscript?.(cleanedInterim)
        }

        recognition.onerror = (event: any) => {
          console.warn("[useVoiceInput] recognition error:", event.error)
          if (event.error === "no-speech") return
          const err = event.error === "not-allowed" ? "micPermissionDenied" : event.error
          setErrorMessage(err)
          onError?.(err)
          setStatus("error")
          cleanupAudio()
        }

        recognition.onend = () => {
          cleanupAudio()
          setStatus("idle")
          setInterimText("")
        }

        recognition.start()
        setStatus("listening")
      } catch (err: any) {
        console.error("[useVoiceInput] start failed:", err)
        setErrorMessage(err?.message || "Failed to start speech recognition")
        setStatus("error")
        cleanupAudio()
      }
      return
    }

    if (navigator.mediaDevices?.getUserMedia) {
      setMode("whisper")
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        mediaStreamRef.current = stream
        startVolumeMeter(stream)

        const recorder = new MediaRecorder(stream)
        mediaRecorderRef.current = recorder
        audioChunksRef.current = []

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            audioChunksRef.current.push(e.data)
          }
        }

        recorder.start(250)
        setStatus("listening")
      } catch (err: any) {
        const msg = err.name === "NotAllowedError" ? "micPermissionDenied" : err.message
        setErrorMessage(msg)
        onError?.(msg)
        setStatus("error")
        cleanupAudio()
      }
      return
    }

    setErrorMessage("speechNotSupported")
    onError?.("speechNotSupported")
    setStatus("error")
  }, [asrEndpoint, lang, onTranscript, onInterimTranscript, onError, startVolumeMeter, cleanupAudio])

  const stopListening = useCallback(() => {
    if (mode === "gemini") {
      setStatus("transcribing")
      setInterimText("⚡ 正在通过 Gemini 识别中英文...")

      if (processorRef.current) {
        try {
          processorRef.current.disconnect()
        } catch {}
        processorRef.current = null
      }
      cleanupAudio()

      void (async () => {
        try {
          const chunks = pcmChunksRef.current
          const totalSamples = chunks.reduce((acc, c) => acc + c.length, 0)
          if (totalSamples > 0) {
            const merged = new Float32Array(totalSamples)
            let offset = 0
            for (const c of chunks) {
              merged.set(c, offset)
              offset += c.length
            }
            pcmChunksRef.current = []

            const wavBlob = encodeWav(merged, sampleRateRef.current || 16000)
            const transcript = await transcribeAudioWithGemini(wavBlob)
            if (transcript) {
              onTranscript?.(transcript, true)
            }
          }
        } catch (err: any) {
          console.warn("[useVoiceInput] Gemini transcription error:", err)
          onError?.(err?.message || "Gemini ASR failed")
        } finally {
          setStatus("idle")
          setInterimText("")
        }
      })()
      return
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {}
      if (interimText.trim()) {
        onTranscript?.(interimText.trim(), true)
        setInterimText("")
      }
      cleanupAudio()
      setStatus("idle")
      return
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      setStatus("transcribing")
      mediaRecorderRef.current.onstop = async () => {
        cleanupAudio()
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" })
        audioChunksRef.current = []

        if (asrEndpoint) {
          try {
            const formData = new FormData()
            formData.append("file", audioBlob, "audio.webm")
            formData.append("model", "whisper-1")
            formData.append("language", lang?.startsWith("zh") ? "zh" : "en")

            const res = await fetch(asrEndpoint, {
              method: "POST",
              headers: asrApiKey ? { Authorization: "Bearer " + asrApiKey } : {},
              body: formData,
            })
            if (!res.ok) throw new Error("ASR HTTP " + res.status)
            const data = await res.json()
            const text = data.text || ""
            if (text) {
              onTranscript?.(text, true)
            }
          } catch (e: any) {
            setErrorMessage(e.message)
            onError?.(e.message)
          }
        }
        setStatus("idle")
      }
      try {
        mediaRecorderRef.current.stop()
      } catch {
        cleanupAudio()
        setStatus("idle")
      }
    }
  }, [interimText, onTranscript, asrEndpoint, asrApiKey, lang, onError, cleanupAudio])

  return {
    status,
    mode,
    isSupported,
    volume,
    interimText,
    errorMessage,
    startListening,
    stopListening,
    cancel,
  }
}
