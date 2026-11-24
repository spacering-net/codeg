import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { saveChatHtmlEnabled, useChatHtmlEnabled } from "./chat-html-prefs"

beforeEach(() => localStorage.clear())

describe("聊天 HTML 渲染设置", () => {
  it("默认关闭，修改后持久保存并通知同一窗口的读者", () => {
    const first = renderHook(useChatHtmlEnabled)
    const second = renderHook(useChatHtmlEnabled)
    expect(first.result.current).toBe(false)
    act(() => saveChatHtmlEnabled(true))
    expect(first.result.current).toBe(true)
    expect(second.result.current).toBe(true)
    expect(localStorage.getItem("workspace:chat-html-rendering")).toBe("true")
  })

  it("响应其他窗口的设置修改和清空存储", () => {
    const { result } = renderHook(useChatHtmlEnabled)
    act(() => {
      localStorage.setItem("workspace:chat-html-rendering", "true")
      window.dispatchEvent(
        new StorageEvent("storage", { key: "workspace:chat-html-rendering" })
      )
    })
    expect(result.current).toBe(true)
    act(() => {
      localStorage.clear()
      window.dispatchEvent(new StorageEvent("storage", { key: null }))
    })
    expect(result.current).toBe(false)
  })
})
