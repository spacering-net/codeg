import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  MachineText,
  machineTextPieces,
  type MachineTextBreaks,
} from "./machine-text"

/** The runs `text` is cut into, each followed by "|" where a line may break
 *  and "~" where the browser must not break by itself. */
function cuts(text: string, breaks?: MachineTextBreaks): string {
  return machineTextPieces(text, breaks)
    .map(
      (piece) =>
        piece.text +
        (piece.after === "break" ? "|" : piece.after === "hold" ? "~" : "")
    )
    .join("")
}

describe("machineTextPieces — between parts", () => {
  it("breaks after / : @ . - and =", () => {
    expect(cuts("pypi:browser-use@0.13.11")).toBe("pypi:|browser-|use@|0.13.11")
    expect(cuts("X-Browser-Use-API-Key")).toBe("X-|Browser-|Use-|API-|Key")
    expect(cuts("npm:@agent-infra/mcp-server-browser@1.2.29")).toBe(
      "npm:|@agent-|infra/|mcp-|server-|browser@|1.2.29"
    )
    expect(cuts("BROWSER_USE_LOGGING_LEVEL=info")).toBe(
      "BROWSER_USE_LOGGING_LEVEL=|info"
    )
  })

  it("keeps a number whole", () => {
    expect(cuts("0.13.11")).toBe("0.13.11")
    expect(cuts("2026-11-15")).toBe("2026-11-15")
    // A port is a part of its own.
    expect(cuts("127.0.0.1:8080")).toBe("127.0.0.1:|8080")
    expect(cuts("1.0.0-beta.1")).toBe("1.0.0-|beta.|1")
  })

  it("breaks after a run of the same character, and not inside ://", () => {
    expect(cuts("https://mcp.linear.app/sse?api_key=abc")).toBe(
      "https://|mcp.|linear.|app/|sse?api_key=|abc"
    )
    expect(cuts("--flag=value")).toBe("--flag=|value")
  })

  it("never leaves the punctuation that opens a part alone on a line", () => {
    expect(cuts("@modelcontextprotocol/server-filesystem")).toBe(
      "@modelcontextprotocol/|server-|filesystem"
    )
    expect(cuts("/Users/maria/.cline/settings.json")).toBe(
      "/Users/|maria/|.cline/|settings.|json"
    )
    // A space is a place to break of its own: what follows starts afresh.
    expect(cuts("npx -y @scope/pkg")).toBe("npx -y @scope/|pkg")
  })

  it("adds nothing at the end, and nothing to text without parts", () => {
    expect(cuts("example.com/")).toBe("example.|com/")
    expect(cuts("python")).toBe("python")
    expect(cuts("")).toBe("")
  })
})

describe("machineTextPieces — a path", () => {
  it("breaks after a slash only, holding every other place", () => {
    expect(cuts("github.com/browser-use/browser-use", "path")).toBe(
      "github.~com/|browser-~use/|browser-~use"
    )
    expect(cuts("example.com/docs?page=a-b", "path")).toBe(
      "example.~com/|docs?~page=~a-~b"
    )
  })

  it("breaks after the scheme's slashes, not between them", () => {
    expect(cuts("http://github.com/acme", "path")).toBe(
      "http://|github.~com/|acme"
    )
  })
})

describe("machineTextPieces", () => {
  it("only ever splits the text", () => {
    for (const text of [
      "pypi:browser-use@0.13.11",
      "/Users/maria/Library/Application Support/Code/cline_mcp_settings.json",
      'uvx --from "browser-use[cli]==0.13.11" browser-use --mcp',
      "github.com/anthropics/claude-plugins-official",
      "@@--..//::==",
      " a - b ",
    ]) {
      for (const breaks of ["parts", "path"] as const) {
        const pieces = machineTextPieces(text, breaks)
        expect(pieces.map((piece) => piece.text).join("")).toBe(text)
        expect(pieces.every((piece) => piece.text !== "")).toBe(true)
      }
    }
  })
})

describe("MachineText", () => {
  /** The box `MachineText` puts its text in. */
  const textBox = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".\\[overflow-wrap\\:anywhere\\]")!

  it("adds marks, and no text", () => {
    const { container } = render(
      <code>
        <MachineText>pypi:browser-use@0.13.11</MachineText>
      </code>
    )
    const code = container.querySelector("code")!
    // What is copied, searched for and read out is the value as it is.
    expect(code.textContent).toBe("pypi:browser-use@0.13.11")
    expect(screen.getByText("pypi:browser-use@0.13.11")).toBe(
      textBox(container)
    )
    const marks = textBox(container).querySelectorAll("span")
    expect(marks).toHaveLength(3)
    for (const mark of marks) {
      expect(mark).toHaveClass("wrap-point")
      expect(mark).toBeEmptyDOMElement()
    }
  })

  it("breaks a value with no place of its own to break anywhere", () => {
    // A key of letters and digits alone: nothing to prefer, and too long for
    // a phone's line. Its own box says it may break anywhere, and may be as
    // narrow as needed in a flex or grid row — whatever box it is put in.
    const key =
      "mcpserverwithaverylongkeythatkeepsgoingwithoutanypunctuation0123"
    expect(key).toHaveLength(64)
    const { container } = render(
      <span className="flex">
        <MachineText>{key}</MachineText>
      </span>
    )
    const box = textBox(container)
    expect(box).toHaveClass("min-w-0", "[overflow-wrap:anywhere]")
    expect(box.textContent).toBe(key)
    expect(box.querySelector(".wrap-point, .wrap-hold")).toBeNull()
  })

  it("holds a path's own places to break", () => {
    const { container } = render(
      <MachineText breaks="path">
        github.com/browser-use/browser-use
      </MachineText>
    )
    expect(container.textContent).toBe("github.com/browser-use/browser-use")
    expect(container.querySelectorAll(".wrap-point")).toHaveLength(2)
    expect(container.querySelectorAll(".wrap-hold")).toHaveLength(3)
  })

  it("takes a rich message's chunks as one text", () => {
    const { container } = render(<MachineText>{["codeg-", "mcp"]}</MachineText>)
    expect(textBox(container).innerHTML).toBe(
      'codeg-<span class="wrap-point"></span>mcp'
    )
  })

  it("leaves anything with an element in it as it is, breaking anywhere", () => {
    const { container } = render(
      <MachineText>
        a-b<b>c-d</b>
      </MachineText>
    )
    expect(textBox(container).innerHTML).toBe("a-b<b>c-d</b>")
  })
})
