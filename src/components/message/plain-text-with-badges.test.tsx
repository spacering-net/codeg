import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { KnownInvocationsProvider } from "./known-invocations-context"
import {
  AnnotationReportProvider,
  PlainTextWithBadges,
} from "./plain-text-with-badges"

const badge = (c: HTMLElement, kind: string) =>
  c.querySelector(`[data-reference-badge][data-ref-type='${kind}']`)

describe("PlainTextWithBadges", () => {
  it("renders plain prose as text with no badge", () => {
    const { container } = render(<PlainTextWithBadges text="just some text" />)
    expect(container.textContent).toBe("just some text")
    expect(container.querySelector("[data-reference-badge]")).toBeNull()
  })

  it("reads the message in the direction of its own text", () => {
    // An English message in the Arabic interface keeps its full stop at the
    // end; an Arabic one in an English interface reads right to left.
    const plain = render(<PlainTextWithBadges text="Commit it." />)
    expect(plain.container.firstElementChild).toHaveAttribute("dir", "auto")
    plain.unmount()
    const quoted = render(<PlainTextWithBadges text={"> quoted\nreply"} />)
    expect(quoted.container.firstElementChild).toHaveAttribute("dir", "auto")
  })

  it("renders Markdown syntax verbatim (no formatting elements)", () => {
    const { container } = render(
      <PlainTextWithBadges text={"# Heading\n**bold**\n- item"} />
    )
    expect(container.querySelector("h1")).toBeNull()
    expect(container.querySelector("strong")).toBeNull()
    expect(container.querySelector("li")).toBeNull()
    expect(container.textContent).toContain("# Heading")
    expect(container.textContent).toContain("**bold**")
    expect(container.textContent).toContain("- item")
  })

  it("renders each reference kind as its badge, in place", () => {
    const { container: file } = render(
      <PlainTextWithBadges text="edit [app.ts](file:///repo/app.ts) here" />
    )
    expect(badge(file, "file")).not.toBeNull()
    expect(file.textContent).toContain("edit")
    expect(file.textContent).toContain("here")

    const { container: agent } = render(
      <PlainTextWithBadges text="[@Codex](codeg://agent/codex)" />
    )
    expect(badge(agent, "agent")).not.toBeNull()

    const { container: session } = render(
      <PlainTextWithBadges text="[#42](codeg://session/42)" />
    )
    expect(badge(session, "session")).not.toBeNull()

    const { container: commit } = render(
      <PlainTextWithBadges text="[a1b2c3d](codeg://commit/%2Frepo@a1b2c3ddeadbeef)" />
    )
    expect(badge(commit, "commit")).not.toBeNull()
  })

  it("badges a bare /command token the agent advertises, but not a path", () => {
    const { container: cmd } = render(
      <KnownInvocationsProvider value={new Set(["/review"])}>
        <PlainTextWithBadges text="run /review please" />
      </KnownInvocationsProvider>
    )
    expect(badge(cmd, "skill")).not.toBeNull()
    // The badge shows the bare name (no `/` prefix), matching the composer.
    expect(cmd.textContent).toContain("review")
    expect(cmd.textContent).not.toContain("/review")

    const { container: path } = render(
      <KnownInvocationsProvider value={new Set(["/review"])}>
        <PlainTextWithBadges text="see /usr/bin for it" />
      </KnownInvocationsProvider>
    )
    expect(badge(path, "skill")).toBeNull()
    expect(path.textContent).toContain("/usr/bin")
  })

  it("leaves a slash word the agent does not advertise as text", () => {
    // `/tmp` has the shape of a command; it is not one this agent has.
    const { container } = render(
      <KnownInvocationsProvider value={new Set(["/review"])}>
        <PlainTextWithBadges text="clean /tmp and /rev, then /review" />
      </KnownInvocationsProvider>
    )
    const badges = container.querySelectorAll("[data-reference-badge]")
    expect(badges).toHaveLength(1)
    expect(container.textContent).toContain("clean /tmp and /rev, then ")
  })

  it("badges no bare token without an advertised list", () => {
    // No provider (an embed with no agent) or an agent that has not advertised
    // its commands yet: nothing can be verified, so nothing is claimed.
    const { container: none } = render(
      <PlainTextWithBadges text="run /review please" />
    )
    expect(none.querySelector("[data-reference-badge]")).toBeNull()
    expect(none.textContent).toBe("run /review please")

    const { container: empty } = render(
      <KnownInvocationsProvider value={new Set()}>
        <PlainTextWithBadges text="run /review please" />
      </KnownInvocationsProvider>
    )
    expect(empty.querySelector("[data-reference-badge]")).toBeNull()
  })

  it("re-badges when the advertised list arrives", () => {
    const { container, rerender } = render(
      <KnownInvocationsProvider value={new Set()}>
        <PlainTextWithBadges text="run /review please" />
      </KnownInvocationsProvider>
    )
    expect(badge(container, "skill")).toBeNull()
    rerender(
      <KnownInvocationsProvider value={new Set(["/review"])}>
        <PlainTextWithBadges text="run /review please" />
      </KnownInvocationsProvider>
    )
    expect(badge(container, "skill")).not.toBeNull()
  })

  it("gives a file badge — and only a file badge — the hover-actions anchor", () => {
    const { container: file } = render(
      <PlainTextWithBadges text="edit [app.ts](file:///repo/app.ts) here" />
    )
    const hoverAnchor = file.querySelector("[data-file-actions]")
    expect(hoverAnchor).not.toBeNull()
    expect(hoverAnchor?.contains(badge(file, "file"))).toBe(true)

    // A path-less embedded attachment renders as a file badge too, but there is
    // nothing to reveal or copy — no anchor.
    const { container: embedded } = render(
      <PlainTextWithBadges text="[report.pdf](codeg://embedded/abc-123)" />
    )
    expect(badge(embedded, "file")).not.toBeNull()
    expect(embedded.querySelector("[data-file-actions]")).toBeNull()

    const { container: session } = render(
      <PlainTextWithBadges text="[#42](codeg://session/42)" />
    )
    expect(session.querySelector("[data-file-actions]")).toBeNull()
  })

  it("does NOT badge a non-reference http link", () => {
    const { container } = render(
      <PlainTextWithBadges text="[docs](https://example.com)" />
    )
    expect(container.querySelector("[data-reference-badge]")).toBeNull()
    expect(container.textContent).toBe("[docs](https://example.com)")
  })

  it("preserves newlines via pre-wrap", () => {
    const { container } = render(<PlainTextWithBadges text={"a\nb"} />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain("whitespace-pre-wrap")
    expect(container.textContent).toBe("a\nb")
  })

  describe("quote blocks", () => {
    const quotes = (c: HTMLElement) =>
      Array.from(c.querySelectorAll("[data-testid='user-message-quote']"))

    it("renders a quoted run as a rule block with the markers dropped", () => {
      const { container } = render(
        <PlainTextWithBadges text={"> first\n> second"} />
      )
      const [quote] = quotes(container)
      expect(quote).toBeDefined()
      expect(quote.className).toContain("border-s-2")
      expect(quote.textContent).toBe("first\nsecond")
      // No stray marker anywhere in the bubble.
      expect(container.textContent).not.toContain(">")
    })

    it("keeps the prose after a quote as its own block", () => {
      // The shape the quote action produces: quote, blank separator, question.
      const { container } = render(
        <PlainTextWithBadges text={"> quoted\n\nmy question"} />
      )
      expect(quotes(container)).toHaveLength(1)
      expect(quotes(container)[0].textContent).toBe("quoted")
      // The separator blank line is structure, not content — it must not also
      // survive as a literal newline on top of the block gap.
      expect(container.textContent).toBe("quotedmy question")
    })

    it("nests a doubly-marked quote", () => {
      const { container } = render(<PlainTextWithBadges text="> > deep" />)
      const found = quotes(container)
      expect(found).toHaveLength(2)
      expect(found[0].contains(found[1])).toBe(true)
      expect(found[1].textContent).toBe("deep")
    })

    it("still badges references inside a quote", () => {
      const { container } = render(
        <PlainTextWithBadges text="> edit [app.ts](file:///repo/app.ts) now" />
      )
      const [quote] = quotes(container)
      expect(quote.querySelector("[data-reference-badge]")).not.toBeNull()
      expect(quote.textContent).toContain("now")
    })

    it("does NOT widen Markdown rendering beyond the quote marker", () => {
      const { container } = render(
        <PlainTextWithBadges text={"> # Heading\n> **bold**\n> - item"} />
      )
      expect(container.querySelector("h1")).toBeNull()
      expect(container.querySelector("strong")).toBeNull()
      expect(container.querySelector("li")).toBeNull()
      expect(quotes(container)[0].textContent).toBe(
        "# Heading\n**bold**\n- item"
      )
    })

    it("leaves a `>` that is not line-leading literal", () => {
      const { container } = render(<PlainTextWithBadges text="2 > 1 is true" />)
      expect(quotes(container)).toHaveLength(0)
      expect(container.textContent).toBe("2 > 1 is true")
    })
  })
})

describe("annotation badges", () => {
  const TAGGED =
    '[标注1 - 太远了](codeg://embedded/uid-1)改一下\n<annotation ref="codeg://embedded/uid-1" label="标注1 - 太远了">Comment: 太远了\n</annotation>'

  it("opens the report under the bubble when the badge is clicked", async () => {
    const { container, queryByTestId } = render(
      <AnnotationReportProvider>
        <PlainTextWithBadges text={TAGGED} />
      </AnnotationReportProvider>
    )
    expect(queryByTestId("annotation-report")).toBeNull()
    const button = container.querySelector("button")
    expect(button).not.toBeNull()
    fireEvent.click(button!)
    expect(queryByTestId("annotation-report")?.textContent).toContain(
      "Comment: 太远了"
    )
    fireEvent.click(button!)
    expect(queryByTestId("annotation-report")).toBeNull()
  })

  it("leaves a badge without a report in this message inert", () => {
    const { container } = render(
      <AnnotationReportProvider>
        <PlainTextWithBadges text="[标注9 - x](codeg://embedded/uid-9)" />
      </AnnotationReportProvider>
    )
    // No tag in this message: the badge is not a button — its report has not
    // reached the transcript yet (the optimistic turn before re-read).
    expect(container.querySelector("button")).toBeNull()
  })

  it("leads the bubble with the badges a re-read stored under the prose", () => {
    // The wire puts the context block (hence its badge line) AFTER the typed
    // prose; the composer showed the badges first. Re-read must recompose:
    // badges inline at the front, prose after, no blank runs left behind.
    const { container } = render(
      <AnnotationReportProvider>
        <PlainTextWithBadges
          text={
            "这儿\n\n[页面标注1 - 美化](codeg://embedded/uid-a)\n\n" +
            '<annotation ref="codeg://embedded/uid-a" label="页面标注1 - 美化">Comment: 美化</annotation>'
          }
        />
      </AnnotationReportProvider>
    )
    expect(container.textContent?.startsWith("页面标注1 - 美化这儿")).toBe(true)
    expect(container.textContent).not.toContain("\n")
  })

  it("keeps messages without an annotation report in wire order", () => {
    // Hoist only fires where a report exists; a plain file badge must not
    // jump out of its sentence.
    const { container } = render(
      <PlainTextWithBadges text="open [app.ts](file:///repo/app.ts) first" />
    )
    expect(container.textContent).toBe("open app.ts first")
  })

  it("opens a report held by a sibling part of the same message", () => {
    // The renderer splits one message into one part per content block, so the
    // badge and the `<annotation>` tag typically land in different parts. The
    // provider knows every ref the whole message carries, so the badge is
    // still a button and the click still finds the report next door.
    const { container, queryByTestId } = render(
      <AnnotationReportProvider reports={["codeg://embedded/uid-b"]}>
        <PlainTextWithBadges text="[页面标注2 - 改颜色](codeg://embedded/uid-b)" />
        <PlainTextWithBadges
          text={
            '<annotation ref="codeg://embedded/uid-b" label="页面标注2 - 改颜色">Comment: 改颜色</annotation>'
          }
        />
      </AnnotationReportProvider>
    )
    expect(queryByTestId("annotation-report")).toBeNull()
    const button = container.querySelector("button")
    expect(button).not.toBeNull()
    fireEvent.click(button!)
    expect(queryByTestId("annotation-report")?.textContent).toContain(
      "Comment: 改颜色"
    )
  })
})
