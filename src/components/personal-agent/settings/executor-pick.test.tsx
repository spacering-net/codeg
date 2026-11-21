import { cleanup, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const assistants = vi.hoisted(() => ({
  list: [] as { id: number; name: string; enabled: boolean; avatar: unknown }[],
}))
vi.mock("@/stores/assistants-store", () => ({
  useAssistants: () => assistants.list,
}))
vi.mock("@/components/assistants/assistant-avatar", () => ({
  AssistantAvatar: () => null,
}))

import { ExecutorPick, type ExecutorChoice } from "./executor-pick"

function pick(value: ExecutorChoice, onChange: (v: ExecutorChoice) => void) {
  // In a form, as the identity page has it: the select keeps a native
  // <select> in step with its value.
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <form>
        <ExecutorPick value={value} onChange={onChange} />
      </form>
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  cleanup()
  assistants.list = []
})

describe("the executor config pick", () => {
  it("does not take the bound one's arrival, as the list loads, for a pick of nothing", () => {
    const onChange = vi.fn()
    // The page opened before the executor configs were read: nothing bound
    // can be shown yet.
    const { rerender } = render(pick({ kind: "none" }, onChange))
    // Read: the bound one is there.
    assistants.list = [
      { id: 1, name: "Personal agent", enabled: true, avatar: null },
    ]
    rerender(pick({ kind: "existing", id: 1 }, onChange))
    expect(onChange).not.toHaveBeenCalled()
    expect(
      document
        .querySelector("[data-pa-executor-pick]")
        ?.getAttribute("data-pa-executor-pick")
    ).toBe("1")
  })
})
