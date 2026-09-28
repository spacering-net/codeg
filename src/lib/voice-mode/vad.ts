export type VadEvent =
  | "speech-candidate"
  | "candidate-dropped"
  | "speech-start"
  | "speech-end"

export interface VadState {
  push(rmsDb: number): VadEvent[]
  setPlaybackActive(active: boolean): void
}

export interface VadOptions {
  endSilenceMs: number
  now?: () => number
}

const FLOOR_EMA_ALPHA = 0.05
const BASE_THRESHOLD = 12
const PLAYBACK_THRESHOLD_BOOST = 10
const BASE_START_WINDOW_MS = 150
const PLAYBACK_START_WINDOW_MS = 300
const INITIAL_FLOOR = -60

export function createVad({
  endSilenceMs,
  now = Date.now,
}: VadOptions): VadState {
  let floor = INITIAL_FLOOR
  let state: "silence" | "candidate" | "speech" = "silence"
  let candidateStartTime = 0
  let silenceStartTime: number | null = null
  let playbackActive = false

  return {
    setPlaybackActive(active: boolean) {
      playbackActive = active
    },
    push(rmsDb: number): VadEvent[] {
      const threshold =
        floor + BASE_THRESHOLD + (playbackActive ? PLAYBACK_THRESHOLD_BOOST : 0)
      const events: VadEvent[] = []
      const t = now()

      if (rmsDb < threshold) {
        floor = floor * (1 - FLOOR_EMA_ALPHA) + rmsDb * FLOOR_EMA_ALPHA
      }

      const isAbove = rmsDb >= threshold

      switch (state) {
        case "silence":
          if (isAbove) {
            state = "candidate"
            candidateStartTime = t
            events.push("speech-candidate")
          }
          break

        case "candidate":
          if (!isAbove) {
            state = "silence"
            events.push("candidate-dropped")
          } else {
            const startWindow = playbackActive
              ? PLAYBACK_START_WINDOW_MS
              : BASE_START_WINDOW_MS
            if (t - candidateStartTime >= startWindow) {
              state = "speech"
              events.push("speech-start")
            }
          }
          break

        case "speech":
          if (!isAbove) {
            if (silenceStartTime === null) {
              silenceStartTime = t
            } else if (t - silenceStartTime >= endSilenceMs) {
              state = "silence"
              silenceStartTime = null
              events.push("speech-end")
            }
          } else {
            silenceStartTime = null
          }
          break
      }

      return events
    },
  }
}
