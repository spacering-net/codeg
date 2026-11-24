import { render, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Streamdown, type HighlightOptions } from "streamdown"
import { createCodePlugin, getCodeHighlightStats } from "./code-highlighter"

function markdown(prefix: string, count: number) {
  return Array.from(
    { length: count },
    (_, i) => `\`\`\`javascript\nconst ${prefix}${i} = ${i};\n\`\`\``
  ).join("\n\n")
}

describe("Streamdown highlighting lifecycle", () => {
  it("delivers all 24 real Shiki callbacks after concurrent Markdown saturation", async () => {
    const shared = await createCodePlugin()
    const completed = new Set<string>()
    let peak = 0
    let waited = false
    const code = {
      ...shared,
      highlight(
        options: HighlightOptions,
        callback?: Parameters<typeof shared.highlight>[1]
      ) {
        const result = shared.highlight(options, (tokens) => {
          expect(tokens.fg).not.toBe("inherit")
          completed.add(options.code)
          callback?.(tokens)
        })
        peak = Math.max(peak, getCodeHighlightStats().inFlight)
        waited ||= getCodeHighlightStats().waiting > 0
        return result
      },
    }
    const view = render(
      <Streamdown mode="static" plugins={{ code }}>
        {markdown("realShiki", 24)}
      </Streamdown>
    )
    await waitFor(() => expect(completed.size).toBe(24), { timeout: 15_000 })
    expect(peak).toBe(16)
    expect(waited).toBe(true)
    expect(getCodeHighlightStats().waiting).toBe(0)
    for (let i = 0; i < 24; i++) {
      expect(view.container.textContent).toContain(`realShiki${i}`)
    }
    view.unmount()
  }, 20_000)

  it("aborts the actual Markdown plugin requests on replacement and unmount", async () => {
    const shared = await createCodePlugin()
    const requests: HighlightOptions[] = []
    const code = {
      ...shared,
      highlight(options: HighlightOptions) {
        requests.push(options)
        return null
      },
    }
    const view = render(
      <Streamdown mode="static" plugins={{ code }}>
        {markdown("oldPrefix", 24)}
      </Streamdown>
    )
    await waitFor(() => expect(requests.length).toBe(24))
    const previous = [...requests]
    expect(previous.every(({ signal }) => signal && !signal.aborted)).toBe(true)
    view.rerender(
      <Streamdown mode="static" plugins={{ code }}>
        {markdown("newPrefix", 24)}
      </Streamdown>
    )
    await waitFor(() => expect(requests.length).toBe(48))
    expect(previous.every(({ signal }) => signal?.aborted)).toBe(true)
    view.unmount()
    expect(requests.every(({ signal }) => signal?.aborted)).toBe(true)
  })
})
