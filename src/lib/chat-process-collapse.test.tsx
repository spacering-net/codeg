import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getChatProcessCollapse,
  setChatProcessCollapse,
  useChatProcessCollapse,
} from "./chat-process-collapse"

const KEY = "settings:chat-process-collapse:v1"

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem(KEY)
})

describe("聊天过程折叠设置", () => {
  it("缺省值或损坏值均保持原有行为", () => {
    expect(getChatProcessCollapse()).toBe("current")
    localStorage.setItem(KEY, "invalid")
    expect(getChatProcessCollapse()).toBe("current")
  })

  it("保存设置并通知当前窗口中的所有订阅者", () => {
    const first = renderHook(useChatProcessCollapse)
    const second = renderHook(useChatProcessCollapse)
    act(() => setChatProcessCollapse("after-completion"))
    expect(localStorage.getItem(KEY)).toBe("after-completion")
    expect(first.result.current).toBe("after-completion")
    expect(second.result.current).toBe("after-completion")
    first.unmount()
    second.unmount()
    expect(renderHook(useChatProcessCollapse).result.current).toBe(
      "after-completion"
    )
  })

  it("忽略无关设置并响应其他窗口清空存储", () => {
    localStorage.setItem(KEY, "always")
    const view = renderHook(useChatProcessCollapse)
    act(() =>
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }))
    )
    expect(view.result.current).toBe("always")
    act(() => {
      localStorage.removeItem(KEY)
      window.dispatchEvent(new StorageEvent("storage", { key: null }))
    })
    expect(view.result.current).toBe("current")
  })

  it("无法访问存储时安全回退", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable")
    })
    expect(getChatProcessCollapse()).toBe("current")
  })
})
