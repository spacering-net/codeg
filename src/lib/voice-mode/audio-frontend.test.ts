import { describe, expect, it, vi, beforeEach } from "vitest"
import { startAudioFrontend } from "./audio-frontend"

// Fake Web Audio API
class FakeAudioWorkletPort {
  onmessage: ((event: MessageEvent<number>) => void) | null = null
  postMessage(data: number) {
    if (this.onmessage) this.onmessage({ data } as MessageEvent<number>)
  }
}

let lastPort: FakeAudioWorkletPort | null = null

class FakeAudioWorkletNode {
  port = new FakeAudioWorkletPort()
  constructor() {
    lastPort = this.port
  }
  connect() {}
  disconnect() {}
}

const mockClose = vi.fn()
const mockAddModule = vi.fn().mockResolvedValue(undefined)

class FakeAudioContext {
  audioWorklet = {
    addModule: mockAddModule,
  }
  destination = {}
  createMediaStreamSource() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
  }
  close = mockClose
}

const mockRevoke = vi.fn()
const mockTrackStop = vi.fn()

describe("audio-frontend", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioContext", FakeAudioContext)
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode)
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:fake"),
      revokeObjectURL: mockRevoke,
    })

    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: mockTrackStop }],
        }),
      },
    })

    mockClose.mockClear()
    mockRevoke.mockClear()
    mockTrackStop.mockClear()
    mockAddModule.mockClear()
    mockAddModule.mockResolvedValue(undefined)
    lastPort = null
  })

  it("stops every track, closes context, and revokes URL on stop()", async () => {
    const vad = {
      push: vi.fn().mockReturnValue([]),
      setPlaybackActive: vi.fn(),
    }
    const frontend = await startAudioFrontend({
      onLevel: vi.fn(),
      onVadEvent: vi.fn(),
      vad,
    })

    expect(mockRevoke).toHaveBeenCalledWith("blob:fake")

    await frontend.stop()

    expect(mockTrackStop).toHaveBeenCalledOnce()
    expect(mockClose).toHaveBeenCalledOnce()
  })

  it("idempotent stop() no throws, exactly one close", async () => {
    const vad = {
      push: vi.fn().mockReturnValue([]),
      setPlaybackActive: vi.fn(),
    }
    const frontend = await startAudioFrontend({
      onLevel: vi.fn(),
      onVadEvent: vi.fn(),
      vad,
    })

    await frontend.stop()
    await frontend.stop()

    expect(mockClose).toHaveBeenCalledOnce()
    expect(mockTrackStop).toHaveBeenCalledOnce()
  })

  it("leaks are prevented if addModule fails", async () => {
    mockAddModule.mockRejectedValueOnce(new Error("addModule failed"))

    const vad = {
      push: vi.fn().mockReturnValue([]),
      setPlaybackActive: vi.fn(),
    }
    await expect(
      startAudioFrontend({
        onLevel: vi.fn(),
        onVadEvent: vi.fn(),
        vad,
      })
    ).rejects.toThrow("addModule failed")

    expect(mockTrackStop).toHaveBeenCalledOnce()
    expect(mockClose).toHaveBeenCalledOnce()
    expect(mockRevoke).toHaveBeenCalledWith("blob:fake")
  })

  it("processes worklet messages, converts to dB, feeds vad, triggers callbacks", async () => {
    const mockOnLevel = vi.fn()
    const mockOnVadEvent = vi.fn()
    const mockVadPush = vi.fn().mockReturnValue(["speech-candidate"])

    const vad = { push: mockVadPush, setPlaybackActive: vi.fn() }
    await startAudioFrontend({
      onLevel: mockOnLevel,
      onVadEvent: mockOnVadEvent,
      vad,
    })

    expect(lastPort).not.toBeNull()

    // Simulate a message from the worklet with RMS 0.1 (linear)
    lastPort!.postMessage(0.1)

    // 0.1 linear is 20 * log10(0.1) = -20 dB
    expect(mockOnLevel).toHaveBeenCalledWith(0.1)
    expect(mockVadPush).toHaveBeenCalledWith(-20)
    expect(mockOnVadEvent).toHaveBeenCalledWith("speech-candidate")
  })
})
