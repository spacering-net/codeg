import { act, renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  generate: vi.fn(),
  cancel: vi.fn(async () => {}),
}))
const toastError = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", () => ({
  gitGenerateCommitMessage: api.generate,
  gitGenerateCommitMessageCancel: api.cancel,
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: toastError },
}))

import {
  sameFiles,
  useCommitMessageGeneration,
  type GeneratedMessage,
} from "./use-commit-message-generation"
import enMessages from "@/i18n/messages/en.json"

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

/** A generation the test settles by hand. */
function pending() {
  let resolve!: (value: Generated) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Generated>((res, rej) => {
    resolve = res
    reject = rej
  })
  api.generate.mockReturnValueOnce(promise)
  return { resolve, reject }
}

type Generated = { message: string; agent_type: string; auto_commit: boolean }

const input = { files: ["a.ts"], draft: "fix it", fallbackAgent: null }

describe("useCommitMessageGeneration", () => {
  beforeEach(() => {
    api.generate.mockReset()
    api.cancel.mockClear()
    toastError.mockClear()
  })

  it("hands back the message and asks for exactly the commit's files", async () => {
    const run = pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    let message: Promise<GeneratedMessage | null> = Promise.resolve(null)
    act(() => {
      message = result.current.generate(input)
    })
    expect(result.current.generating).toBe(true)
    expect(api.generate).toHaveBeenCalledWith({
      requestId: expect.any(String),
      path: "/repo",
      folderId: 7,
      files: ["a.ts"],
      draft: "fix it",
      fallbackAgent: null,
    })
    await act(async () => {
      run.resolve({
        message: "fix: it",
        agent_type: "claude_code",
        auto_commit: false,
      })
      expect(await message).toEqual({ message: "fix: it", autoCommit: false })
    })
    expect(result.current.generating).toBe(false)
  })

  it("passes on that the settings want the message committed", async () => {
    const run = pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    let message: Promise<GeneratedMessage | null> = Promise.resolve(null)
    act(() => {
      message = result.current.generate(input)
    })
    await act(async () => {
      run.resolve({
        message: "fix: it",
        agent_type: "claude_code",
        auto_commit: true,
      })
      expect(await message).toEqual({ message: "fix: it", autoCommit: true })
    })
  })

  it("sends no draft for a box holding only whitespace", () => {
    pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    act(() => {
      void result.current.generate({ ...input, draft: "  \n " })
    })
    expect(api.generate.mock.calls[0][0].draft).toBeNull()
  })

  it("stops the run on the backend and drops an answer that still comes", async () => {
    const run = pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    let message: Promise<GeneratedMessage | null> = Promise.resolve(null)
    act(() => {
      message = result.current.generate(input)
    })
    const requestId = api.generate.mock.calls[0][0].requestId
    act(() => result.current.stop())
    expect(api.cancel).toHaveBeenCalledWith(requestId)
    expect(result.current.generating).toBe(false)
    await act(async () => {
      run.resolve({
        message: "too late",
        agent_type: "claude_code",
        auto_commit: false,
      })
      expect(await message).toBeNull()
    })
  })

  it("stops when the folder changes under it", async () => {
    const run = pending()
    const { result, rerender } = renderHook(
      ({ path }) => useCommitMessageGeneration({ path, folderId: 7 }),
      { wrapper, initialProps: { path: "/a" } }
    )
    let message: Promise<GeneratedMessage | null> = Promise.resolve(null)
    act(() => {
      message = result.current.generate(input)
    })
    rerender({ path: "/b" })
    expect(api.cancel).toHaveBeenCalledTimes(1)
    expect(result.current.generating).toBe(false)
    await act(async () => {
      run.resolve({
        message: "for /a",
        agent_type: "claude_code",
        auto_commit: false,
      })
      expect(await message).toBeNull()
    })
  })

  it("stops when the box goes away", () => {
    pending()
    const { result, unmount } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    act(() => {
      void result.current.generate(input)
    })
    unmount()
    expect(api.cancel).toHaveBeenCalledTimes(1)
  })

  it("reports a failure in the user's language, with a way to the settings", async () => {
    const run = pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    let message: Promise<GeneratedMessage | null> = Promise.resolve(null)
    act(() => {
      message = result.current.generate(input)
    })
    await act(async () => {
      run.reject({
        code: "configuration_missing",
        message: "No agent to write the commit message",
        i18n_key: "errors.noAgent",
      })
      expect(await message).toBeNull()
    })
    expect(toastError).toHaveBeenCalledTimes(1)
    const [title, options] = toastError.mock.calls[0]
    expect(title).toBe(enMessages.CommitMessageGeneration.toasts.failed)
    expect(options.description).toBe(
      enMessages.CommitMessageGeneration.errors.noAgent
    )
    act(() => options.action.onClick())
    expect(result.current.settingsOpen).toBe(true)
  })

  it("starts nothing while a run is going or without a folder", () => {
    pending()
    const { result, rerender } = renderHook(
      ({ path }: { path: string | null }) =>
        useCommitMessageGeneration({ path, folderId: 7 }),
      { wrapper, initialProps: { path: "/repo" as string | null } }
    )
    act(() => {
      void result.current.generate(input)
    })
    act(() => {
      void result.current.generate(input)
    })
    expect(api.generate).toHaveBeenCalledTimes(1)

    rerender({ path: null })
    act(() => {
      void result.current.generate(input)
    })
    expect(api.generate).toHaveBeenCalledTimes(1)
  })
})

describe("sameFiles", () => {
  it("compares the files, not their order", () => {
    expect(sameFiles(["a.ts", "b.ts"], ["b.ts", "a.ts"])).toBe(true)
    expect(sameFiles(["a.ts"], ["a.ts", "b.ts"])).toBe(false)
    expect(sameFiles(["a.ts", "b.ts"], ["a.ts", "c.ts"])).toBe(false)
    expect(sameFiles([], [])).toBe(true)
  })
})
