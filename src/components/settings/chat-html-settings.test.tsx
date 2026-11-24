import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { resetHtmlPreviewCachesForTests } from "@/components/ai-elements/html-code-preview"
import { JsonRenderScope } from "@/components/ai-elements/json-render-pre"
import { MessageResponse } from "@/components/ai-elements/message"
import { ChatHtmlSettingsSection } from "./chat-html-settings"

beforeEach(() => {
  localStorage.clear()
  resetHtmlPreviewCachesForTests()
})

describe("聊天 HTML 设置联动", () => {
  it("无需刷新就能开启和关闭当前聊天中的 HTML 渲染", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ChatHtmlSettingsSection />
        <JsonRenderScope>
          <MessageResponse>{"```html\n<div>Card</div>\n```"}</MessageResponse>
        </JsonRenderScope>
      </NextIntlClientProvider>
    )
    const toggle = screen.getByRole("switch", {
      name: "Enable rich HTML rendering",
    })
    expect(toggle).not.toBeChecked()
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    fireEvent.click(toggle)
    expect(await screen.findByTitle("HTML preview")).toBeInTheDocument()
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(screen.queryByTitle("HTML preview")).toBeNull()
  })

  it("其他窗口关闭开关后，当前预览立即卸载", async () => {
    localStorage.setItem("workspace:chat-html-rendering", "true")
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <JsonRenderScope>
          <MessageResponse>{"<div>Card</div>"}</MessageResponse>
        </JsonRenderScope>
      </NextIntlClientProvider>
    )
    await screen.findByTitle("HTML preview")
    act(() => {
      localStorage.setItem("workspace:chat-html-rendering", "false")
      window.dispatchEvent(
        new StorageEvent("storage", { key: "workspace:chat-html-rendering" })
      )
    })
    expect(screen.queryByTitle("HTML preview")).toBeNull()
  })
})
