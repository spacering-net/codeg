/**
 * Adopting the row a mutation answered with.
 *
 * The forge's copy has to win — it is how a pull request merged in the browser
 * a moment ago comes back `merged` rather than the `closed` a local flip would
 * have assumed. The one thing it cannot be trusted on is label COLOUR: GitLab's
 * `with_labels_details` is a list-endpoint parameter, so a single item answers
 * with bare names and every chip in the panel would drop to grey the instant
 * somebody pressed Close.
 */
import { describe, expect, it } from "vitest"

import { mergeForgeRowUpdate } from "./forge-row-update"
import type { ForgeIssueRow } from "./types"

function row(overrides: Partial<ForgeIssueRow> = {}): ForgeIssueRow {
  return {
    number: 42,
    title: "Login times out",
    body: null,
    state: "open",
    draft: false,
    labels: [],
    author: "octocat",
    author_avatar: "https://avatars.githubusercontent.com/u/583231",
    updated_at: null,
    html_url: "https://github.com/o/r/issues/42",
    is_pr: false,
    comments: 3,
    ...overrides,
  }
}

describe("mergeForgeRowUpdate", () => {
  it("takes the forge's row over the one on screen", () => {
    const merged = mergeForgeRowUpdate(
      row({ state: "open", title: "Login times out" }),
      row({ state: "merged", title: "Login times out (edited)", is_pr: true })
    )
    expect(merged.state).toBe("merged")
    expect(merged.title).toBe("Login times out (edited)")
    expect(merged.is_pr).toBe(true)
  })

  it("restores a colour the single-item payload could not carry", () => {
    const merged = mergeForgeRowUpdate(
      row({
        labels: [
          { name: "bug", color: "#d73a4a" },
          { name: "docs", color: "#0075ca" },
        ],
      }),
      // GitLab's answer: names, no colours.
      row({
        state: "closed",
        labels: [
          { name: "bug", color: null },
          { name: "docs", color: null },
        ],
      })
    )
    expect(merged.labels).toEqual([
      { name: "bug", color: "#d73a4a" },
      { name: "docs", color: "#0075ca" },
    ])
    expect(merged.state).toBe("closed")
  })

  it("keeps a colour the forge DID send, and invents none", () => {
    const merged = mergeForgeRowUpdate(
      row({ labels: [{ name: "bug", color: "#d73a4a" }] }),
      row({
        labels: [
          // Recoloured on the forge — the answer wins, this is not a gap.
          { name: "bug", color: "#00ff00" },
          // Never seen before, and genuinely colourless: the neutral chip is
          // the right answer, not a swatch borrowed from somewhere.
          { name: "triage", color: null },
        ],
      })
    )
    expect(merged.labels).toEqual([
      { name: "bug", color: "#00ff00" },
      { name: "triage", color: null },
    ])
  })

  it("drops a label the forge dropped", () => {
    const merged = mergeForgeRowUpdate(
      row({
        labels: [
          { name: "bug", color: "#d73a4a" },
          { name: "docs", color: "#0075ca" },
        ],
      }),
      row({ labels: [{ name: "bug", color: null }] })
    )
    // The merge fills gaps; it never adds rows back.
    expect(merged.labels).toEqual([{ name: "bug", color: "#d73a4a" }])
  })

  it("passes the answer straight through when there is nothing to merge with", () => {
    const answer = row({
      state: "closed",
      labels: [{ name: "bug", color: null }],
    })
    expect(mergeForgeRowUpdate(null, answer)).toBe(answer)
  })
})
