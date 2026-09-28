import type { VadEvent, VadState } from "./vad"

export interface AudioFrontendOptions {
  onLevel: (level: number) => void
  onVadEvent: (event: VadEvent) => void
  vad: VadState
}

export interface AudioFrontend {
  stream: MediaStream
  stop(): Promise<void>
}

// Worklet runs off main thread, keeping VAD active when tab is backgrounded.
// It posts the RMS amplitude of each 20ms block.
const WORKLET_CODE = `
class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.blockSize = sampleRate * 0.02; // 20ms
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    
    for (let i = 0; i < channel.length; i++) {
      this.buffer.push(channel[i]);
      if (this.buffer.length >= this.blockSize) {
        let sumSq = 0;
        for (let j = 0; j < this.buffer.length; j++) {
          sumSq += this.buffer[j] * this.buffer[j];
        }
        const rms = Math.sqrt(sumSq / this.buffer.length);
        this.port.postMessage(rms);
        this.buffer = [];
      }
    }
    return true;
  }
}
registerProcessor("vad-processor", VadProcessor);
`

export async function startAudioFrontend({
  onLevel,
  onVadEvent,
  vad,
}: AudioFrontendOptions): Promise<AudioFrontend> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

  // ONLY AudioContext allowed in the app for voice mode.
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)

  let node: AudioWorkletNode | null = null
  let url = ""

  try {
    const blob = new Blob([WORKLET_CODE], { type: "application/javascript" })
    url = URL.createObjectURL(blob)
    await ctx.audioWorklet.addModule(url)
    node = new AudioWorkletNode(ctx, "vad-processor")
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    await ctx.close()
    throw error
  } finally {
    if (url) URL.revokeObjectURL(url)
  }

  node.port.onmessage = (event: MessageEvent<number>) => {
    const rms = event.data
    // Convert linear RMS (0..1) to decibels
    const db = rms > 0 ? 20 * Math.log10(rms) : -100

    onLevel(rms)

    const events = vad.push(db)
    for (const e of events) {
      onVadEvent(e)
    }
  }

  source.connect(node)
  node.connect(ctx.destination)

  let stopped = false

  return {
    stream,
    async stop() {
      if (stopped) return
      stopped = true

      node.port.onmessage = null
      node.disconnect()
      source.disconnect()

      stream.getTracks().forEach((track) => track.stop())
      await ctx.close()
    },
  }
}
