import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest"
import { getWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import * as api from "@/lib/api"

// Token-set state machine for the per-root workspace stream store:
// full/paths subscription modes, upgrade/downgrade transitions against the
// backend, idempotent release, and the shutdown-grace lifecycle. Each test
// uses a unique root path — stores are module-level singletons.

vi.mock("@/lib/api", () => ({
  startWorkspaceStateStream: vi.fn(),
  stopWorkspaceStateStream: vi.fn(),
  getWorkspaceSnapshot: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
}))

const mockedApi = api as unknown as {
  startWorkspaceStateStream: Mock
  stopWorkspaceStateStream: Mock
  getWorkspaceSnapshot: Mock
}

function fullSnapshot(rootPath: string, seq = 0) {
  return {
    root_path: rootPath,
    seq,
    version: 1,
    full: true,
    tree_snapshot: [],
    git_snapshot: [],
    deltas: [],
    degraded: false,
    is_git_repo: true,
  }
}

// Drain resolved promises + due timers deterministically.
const drain = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  mockedApi.startWorkspaceStateStream.mockReset()
  mockedApi.stopWorkspaceStateStream.mockReset()
  mockedApi.getWorkspaceSnapshot.mockReset()
  mockedApi.startWorkspaceStateStream.mockImplementation((rootPath: string) =>
    Promise.resolve(fullSnapshot(rootPath))
  )
  mockedApi.stopWorkspaceStateStream.mockResolvedValue(undefined)
  mockedApi.getWorkspaceSnapshot.mockImplementation((rootPath: string) =>
    Promise.resolve(fullSnapshot(rootPath))
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe("workspace state store full/paths token machine", () => {
  it("registers a paths-only subscription without tree/git scanning", async () => {
    const store = getWorkspaceStateStore("/machine/t1")
    const token = store.acquire("paths")
    await drain()

    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t1",
      false
    )

    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t1",
      false
    )
  })

  it("upgrades paths→full by adding the full ref BEFORE releasing the paths ref", async () => {
    const store = getWorkspaceStateStore("/machine/t2")
    const pathsToken = store.acquire("paths")
    await drain()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t2",
      false
    )

    const fullToken = store.acquire("full")
    await drain()

    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t2",
      true
    )
    // The old paths ref is released only after the full ref registered —
    // the backend refcount never touched zero (no teardown mid-upgrade).
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t2",
      false
    )
    const startOrder =
      mockedApi.startWorkspaceStateStream.mock.invocationCallOrder[1]
    const stopOrder =
      mockedApi.stopWorkspaceStateStream.mock.invocationCallOrder[0]
    expect(startOrder).toBeLessThan(stopOrder)

    store.release(fullToken)
    store.release(pathsToken)
    await vi.advanceTimersByTimeAsync(700)
  })

  it("downgrades full→paths on last full release, keeping the stream alive", async () => {
    const store = getWorkspaceStateStore("/machine/t3")
    const fullToken = store.acquire("full")
    await drain()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t3",
      true
    )
    const pathsToken = store.acquire("paths")
    await drain()

    store.release(fullToken)
    await drain()

    // Transition: re-register as paths, release the full ref.
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t3",
      false
    )
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t3",
      true
    )

    // The stream survives: no shutdown while the paths token remains.
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)

    store.release(pathsToken)
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(2)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t3",
      false
    )
  })

  it("treats a duplicate release as a no-op (StrictMode-safe)", async () => {
    const store = getWorkspaceStateStore("/machine/t4")
    const first = store.acquire("paths")
    const second = store.acquire("paths")
    await drain()

    store.release(first)
    store.release(first)
    store.release(first)
    await vi.advanceTimersByTimeAsync(700)

    // `second` still holds the stream — the duplicate releases must not
    // have driven the token count to zero.
    expect(mockedApi.stopWorkspaceStateStream).not.toHaveBeenCalled()

    store.release(second)
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)
  })

  it("re-acquiring within the shutdown grace reuses the stream and resyncs", async () => {
    const store = getWorkspaceStateStore("/machine/t5")
    const token = store.acquire("paths")
    await drain()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    const snapshotCallsAfterStart =
      mockedApi.getWorkspaceSnapshot.mock.calls.length

    store.release(token)
    await vi.advanceTimersByTimeAsync(300)

    const token2 = store.acquire("paths")
    await vi.advanceTimersByTimeAsync(700)

    // No stop, no second start — the grace window kept the stream.
    expect(mockedApi.stopWorkspaceStateStream).not.toHaveBeenCalled()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    // Events during the ref-less window may have been dropped — the store
    // must pull a catch-up snapshot.
    expect(mockedApi.getWorkspaceSnapshot.mock.calls.length).toBeGreaterThan(
      snapshotCallsAfterStart
    )

    store.release(token2)
    await vi.advanceTimersByTimeAsync(700)
  })

  it("reconciles a full token acquired while the initial paths start is in flight", async () => {
    let resolveStart: ((value: unknown) => void) | null = null
    mockedApi.startWorkspaceStateStream.mockImplementationOnce(
      () => new Promise((resolve) => (resolveStart = resolve))
    )

    const store = getWorkspaceStateStore("/machine/t6")
    const pathsToken = store.acquire("paths")
    // Start call is pending; a full subscriber joins meanwhile.
    const fullToken = store.acquire("full")

    resolveStart!(fullSnapshot("/machine/t6"))
    await drain()
    await drain()

    // The post-start reconciliation upgraded the subscription to full.
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t6",
      true
    )
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t6",
      false
    )

    store.release(fullToken)
    store.release(pathsToken)
    await vi.advanceTimersByTimeAsync(700)
  })
})
