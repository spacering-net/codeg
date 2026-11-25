import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { messageMatterWords } from "./work-cards"

/** The words codeg writes a message's matters in (`messages.rs`). */
const rust = readFileSync(
  join(process.cwd(), "src-tauri/src/personal_agent/messages.rs"),
  "utf8"
)

describe("a message's matter written by codeg", () => {
  it("is read in the words the backend writes it in", () => {
    expect(rust).toContain(
      `summary: format!("{} wrote to you: {excerpt}", display_name(&me))`
    )
    expect(rust).toContain(
      `waiting_summary: format!("Waiting for {}'s answer: {excerpt}", display_name(&to))`
    )
    expect(
      messageMatterWords("Waiting for 产品's answer: 请基于\n第二行")
    ).toEqual({ key: "waitingAnswer", name: "产品", text: "请基于\n第二行" })
    expect(messageMatterWords("研发 wrote to you: 看一下")).toEqual({
      key: "wroteToYou",
      name: "研发",
      text: "看一下",
    })
  })

  it("leaves anyone else's words as they are", () => {
    expect(messageMatterWords("Ask 产品 about the roadmap")).toBeNull()
  })
})
