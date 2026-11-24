import { render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { MessageResponse } from "./message"

const { renderMermaid } = vi.hoisted(() => ({
  renderMermaid: vi.fn(async () => ({
    svg: '<svg viewBox="0 0 400 300"><g data-testid="flowchart" /></svg>',
  })),
}))

// Keep the real streaming Markdown pipeline; only the layout-dependent engine
// is replaced, so a fence accidentally joined to prose cannot pass this test.
vi.mock("@streamdown/mermaid", () => ({
  mermaid: {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid: () => ({ render: renderMermaid }),
  },
}))
vi.mock("@/hooks/use-appearance", () => ({
  useAppearance: () => ({ isDarkMode: false }),
}))
vi.mock("./link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

const INTRO = "我先画一个简单的任务处理流程，看看 Mermaid 的渲染效果。"
const SOURCE =
  "flowchart TD\n    A([开始]) --> B[提交任务]\n    B --> C[分析需求]"
const REPLY = `${INTRO}\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\``

describe("streamed Mermaid after a commentary message", () => {
  it("renders the growing fence and keeps the diagram when the turn settles", async () => {
    const response = (text: string, streaming: boolean) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageResponse
          mode={streaming ? "streaming" : "static"}
          parseIncompleteMarkdown={streaming}
        >
          {text}
        </MessageResponse>
      </NextIntlClientProvider>
    )
    const { container, rerender } = render(response(INTRO, true))
    for (const suffix of ["```mer", `\`\`\`mermaid\n${SOURCE}`]) {
      rerender(response(`${INTRO}\n\n${suffix}`, true))
    }
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="flowchart"]')
      ).not.toBeNull()
    )

    rerender(response(REPLY, true))
    await waitFor(() =>
      expect(renderMermaid).toHaveBeenLastCalledWith(
        expect.any(String),
        `${SOURCE}\n`
      )
    )
    rerender(response(REPLY, false))
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="flowchart"]')
      ).not.toBeNull()
    )
    expect(container.querySelector("p")?.textContent).toBe(INTRO)
    expect(container.querySelector("pre")).toBeNull()
    expect(container.textContent).not.toContain("```")
  })
})
