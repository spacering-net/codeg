import { describe, expect, it } from "vitest"

import { splitLine } from "./list-row"

describe("a list row's line", () => {
  it("splits at the first colon of a subject's", () => {
    expect(splitLine("啊啊啊：等待 3 天：需要你说明")).toEqual({
      head: "啊啊啊",
      text: "等待 3 天：需要你说明",
    })
    expect(splitLine("Dev: see https://x.dev/a: b")).toEqual({
      head: "Dev",
      text: "see https://x.dev/a: b",
    })
  })

  it("leaves a line that has none", () => {
    expect(splitLine("no colon here")).toBeNull()
    expect(splitLine("see https://x.dev")).toBeNull()
    expect(splitLine("：nothing before")).toBeNull()
    expect(splitLine("nothing after：")).toBeNull()
    expect(splitLine("一句话。然后：别的")).toBeNull()
    expect(splitLine(`${"长".repeat(61)}：太长`)).toBeNull()
    expect(splitLine(`${"长".repeat(60)}：刚好`)?.head).toHaveLength(60)
  })
})
