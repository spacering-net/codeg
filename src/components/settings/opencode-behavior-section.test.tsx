import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { OpenCodeBehaviorSection } from "./opencode-behavior-section"
import arMessages from "@/i18n/messages/ar.json"
import deMessages from "@/i18n/messages/de.json"
import enMessages from "@/i18n/messages/en.json"
import esMessages from "@/i18n/messages/es.json"
import frMessages from "@/i18n/messages/fr.json"
import jaMessages from "@/i18n/messages/ja.json"
import koMessages from "@/i18n/messages/ko.json"
import ptMessages from "@/i18n/messages/pt.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import zhTWMessages from "@/i18n/messages/zh-TW.json"
import { parseJsoncObject } from "@/lib/jsonc-edit"

/** The section as the settings card holds it: the document is the card's state. */
function Harness({
  initial,
  documents,
}: {
  initial: string
  documents: string[]
}) {
  const [text, setText] = useState(initial)
  return (
    <>
      <OpenCodeBehaviorSection
        configText={text}
        onChange={(next) => {
          documents.push(next)
          setText(next)
        }}
      />
      {/* Stands in for the raw JSON box next to the section. */}
      <button
        type="button"
        onClick={() =>
          setText(JSON.stringify({ compaction: { buffer: 30000 } }))
        }
      >
        edit json
      </button>
    </>
  )
}

function renderSection(initial: string) {
  const documents: string[] = []
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Harness initial={initial} documents={documents} />
    </NextIntlClientProvider>
  )
  const input = screen.getByLabelText("Reserved tokens") as HTMLInputElement
  const buffer = () =>
    (
      parseJsoncObject(documents[documents.length - 1] ?? initial).value
        ?.compaction as Record<string, unknown> | undefined
    )?.buffer
  return { input, documents, buffer }
}

describe("OpenCodeBehaviorSection — compaction buffer", () => {
  it("shows a share of the window the document holds", () => {
    const { input } = renderSection(
      JSON.stringify({ compaction: { buffer: "20%" } })
    )
    expect(input.type).toBe("text")
    expect(input).toHaveValue("20%")
  })

  it("keeps what is typed on the way to a share and writes only values", () => {
    const { input, buffer } = renderSection("{}")
    input.focus()
    const steps: [string, unknown][] = [
      ["1", 1],
      ["12", 12],
      // Spells no value: shown as typed, the document keeps 12.
      ["12.", 12],
      ["12.5", 12],
      ["12.5%", "12.5%"],
    ]
    for (const [typed, stored] of steps) {
      fireEvent.change(input, { target: { value: typed } })
      expect(input, typed).toHaveValue(typed)
      expect(buffer(), typed).toBe(stored)
    }
    // Back to a token count, then empty: unset.
    fireEvent.change(input, { target: { value: "20000" } })
    expect(buffer()).toBe(20000)
    fireEvent.change(input, { target: { value: "" } })
    expect(buffer()).toBeUndefined()
    expect(input).toHaveValue("")
  })

  it("shows the document again on blur", () => {
    const { input, buffer } = renderSection(
      JSON.stringify({ compaction: { buffer: "20%" } })
    )
    input.focus()
    fireEvent.change(input, { target: { value: "25." } })
    expect(input).toHaveValue("25.")
    expect(buffer()).toBe(25)
    fireEvent.blur(input)
    expect(input).toHaveValue("25")

    // A share OpenCode rejects is never written.
    fireEvent.change(input, { target: { value: "100%" } })
    expect(input).toHaveValue("100%")
    expect(buffer()).toBe(25)
    fireEvent.blur(input)
    expect(input).toHaveValue("25")
  })

  it("follows an edit made elsewhere while typing", () => {
    const { input } = renderSection("{}")
    input.focus()
    fireEvent.change(input, { target: { value: "12." } })
    expect(input).toHaveValue("12.")
    fireEvent.click(screen.getByText("edit json"))
    expect(input).toHaveValue("30000")
  })

  it("leaves the other limits numeric inputs", () => {
    renderSection("{}")
    expect(
      (screen.getByLabelText("Tool output line limit") as HTMLInputElement).type
    ).toBe("number")
  })

  it("quotes both forms in the hint as code", () => {
    renderSection("{}")
    for (const literal of ["20000", "1%", "99%", "20%"]) {
      expect(screen.getByText(literal).tagName).toBe("CODE")
    }
  })
})

describe("OpenCodeBehaviorSection — buffer hint in every locale", () => {
  it.each([
    ["ar", arMessages],
    ["de", deMessages],
    ["en", enMessages],
    ["es", esMessages],
    ["fr", frMessages],
    ["ja", jaMessages],
    ["ko", koMessages],
    ["pt", ptMessages],
    ["zh-CN", zhCNMessages],
    ["zh-TW", zhTWMessages],
  ] as const)(
    "%s writes every value the way the field takes it",
    (_, messages) => {
      const hint = messages.AcpAgentSettings.openCode.behavior.hints.reserved
      for (const literal of ["20000", "1%", "99%", "20%", "15%", "16000"]) {
        expect(hint).toContain(`<code>${literal}</code>`)
      }
      // No token count in a form the field rejects ("16K", "16,000", "16 000").
      expect(hint).not.toMatch(/16\s?K|16[,.\s  ]000/)
    }
  )
})
