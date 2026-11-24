import { describe, expect, it } from "vitest"

import { shortPath } from "./format"

describe("shortPath", () => {
  it("keeps the last two segments of a POSIX path", () => {
    expect(shortPath("/home/me/repo/src/a.ts")).toBe("src/a.ts")
    expect(shortPath("/home/a.ts")).toBe("home/a.ts")
  })

  // Agents running on Windows report `file_path` with backslashes, so a
  // "/"-only split left the whole absolute path in the tool title.
  it("keeps the last two segments of a Windows path", () => {
    expect(shortPath("C:\\work\\repo\\src\\a.ts")).toBe("src\\a.ts")
    expect(shortPath("\\\\server\\share\\repo\\a.ts")).toBe("repo\\a.ts")
  })

  it("leaves a path with two or fewer segments alone", () => {
    expect(shortPath("a.ts")).toBe("a.ts")
    expect(shortPath("src/a.ts")).toBe("src/a.ts")
    expect(shortPath("src\\a.ts")).toBe("src\\a.ts")
  })
})
