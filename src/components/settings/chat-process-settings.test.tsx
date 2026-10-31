import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, expect, it } from "vitest"

import zhMessages from "@/i18n/messages/zh-CN.json"
import { getChatProcessCollapse } from "@/lib/chat-process-collapse"
import { ChatProcessSettingsSection } from "./chat-process-settings"

afterEach(() => localStorage.removeItem("settings:chat-process-collapse:v1"))

it("在设置中提供三个模式并持久化用户选择", async () => {
  render(
    <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
      <ChatProcessSettingsSection />
    </NextIntlClientProvider>
  )
  expect(
    screen.getByRole("combobox", { name: "聊天过程详情" })
  ).toHaveTextContent("执行过程全程展开")
  fireEvent.click(screen.getByRole("combobox"))
  expect(screen.getAllByRole("option")).toHaveLength(3)
  fireEvent.click(screen.getByRole("option", { name: "执行结束后折叠" }))
  await waitFor(() => expect(getChatProcessCollapse()).toBe("after-completion"))
  expect(screen.getByRole("combobox")).toHaveTextContent("执行结束后折叠")
})
