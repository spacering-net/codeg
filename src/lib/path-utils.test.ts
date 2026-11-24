import { describe, expect, it } from "vitest"

import {
  fsBaseName,
  joinFsPath,
  parentFsPath,
  siblingFsPath,
} from "./path-utils"

describe("parentFsPath", () => {
  describe("POSIX paths", () => {
    it("returns the parent directory", () => {
      expect(parentFsPath("/home/me/work")).toBe("/home/me")
      expect(parentFsPath("/home/me")).toBe("/home")
    })

    it("returns the root for a first-level directory", () => {
      expect(parentFsPath("/home")).toBe("/")
    })

    it("ignores a trailing slash", () => {
      expect(parentFsPath("/home/me/")).toBe("/home")
    })

    it("returns null at the filesystem root", () => {
      expect(parentFsPath("/")).toBeNull()
    })

    it("returns null for a bare relative segment with no parent", () => {
      expect(parentFsPath("foo")).toBeNull()
    })
  })

  describe("Windows drive paths", () => {
    it("returns the parent directory", () => {
      expect(parentFsPath("C:\\Users\\a\\project")).toBe("C:\\Users\\a")
      expect(parentFsPath("C:\\Users\\a")).toBe("C:\\Users")
    })

    it("returns the drive root (with separator) for a first-level dir", () => {
      expect(parentFsPath("C:\\Users")).toBe("C:\\")
    })

    it("returns null at the drive root", () => {
      expect(parentFsPath("C:\\")).toBeNull()
      expect(parentFsPath("C:")).toBeNull()
    })
  })

  describe("UNC paths", () => {
    it("returns the parent within a share", () => {
      expect(parentFsPath("\\\\server\\share\\folder\\sub")).toBe(
        "\\\\server\\share\\folder"
      )
      expect(parentFsPath("\\\\server\\share\\folder")).toBe(
        "\\\\server\\share"
      )
    })

    it("returns null at or above the share root", () => {
      expect(parentFsPath("\\\\server\\share")).toBeNull()
      expect(parentFsPath("\\\\server")).toBeNull()
    })

    it("handles forward-slash UNC prefixes", () => {
      expect(parentFsPath("//server/share/folder")).toBe("//server/share")
      expect(parentFsPath("//server/share")).toBeNull()
    })
  })

  it("returns null for an empty path", () => {
    expect(parentFsPath("")).toBeNull()
  })
})

describe("joinFsPath", () => {
  it("joins POSIX paths with a forward slash", () => {
    expect(joinFsPath("/home/me", "work")).toBe("/home/me/work")
  })

  it("does not double the separator when the base already ends with one", () => {
    expect(joinFsPath("/home/me/", "work")).toBe("/home/me/work")
    expect(joinFsPath("C:\\Users\\", "a")).toBe("C:\\Users\\a")
  })

  it("joins Windows paths with a backslash and normalizes the relative part", () => {
    expect(joinFsPath("C:\\Users", "a")).toBe("C:\\Users\\a")
    expect(joinFsPath("C:\\Users", "a/b")).toBe("C:\\Users\\a\\b")
  })

  it("returns the base unchanged for an empty relative path", () => {
    expect(joinFsPath("/base", "")).toBe("/base")
  })

  // A directory field the user typed by hand can hold a drive designator with
  // no separator yet; appending "/" there produced the mixed `C:/repo` form
  // next to the `C:\…` the folder picker hands back.
  it("treats a bare Windows drive as a backslash path", () => {
    expect(joinFsPath("C:", "repo")).toBe("C:\\repo")
    expect(joinFsPath("c:", "repo")).toBe("c:\\repo")
  })

  it("keeps forward slashes for a base that already uses them", () => {
    expect(joinFsPath("C:/work", "repo")).toBe("C:/work/repo")
  })

  it("joins onto a bare relative segment with a forward slash", () => {
    expect(joinFsPath("work", "repo")).toBe("work/repo")
  })
})

describe("fsBaseName", () => {
  it("returns the last segment of a POSIX path", () => {
    expect(fsBaseName("/home/me/repo")).toBe("repo")
    expect(fsBaseName("/home/me/repo/")).toBe("repo")
    expect(fsBaseName("repo")).toBe("repo")
  })

  it("returns the last segment of a Windows path", () => {
    expect(fsBaseName("C:\\work\\repo")).toBe("repo")
    expect(fsBaseName("C:\\work\\repo\\")).toBe("repo")
    expect(fsBaseName("\\\\server\\share\\repo")).toBe("repo")
  })

  it("returns an empty string for a root, which has no name", () => {
    expect(fsBaseName("/")).toBe("")
    expect(fsBaseName("C:\\")).toBe("")
    expect(fsBaseName("C:")).toBe("")
    expect(fsBaseName("")).toBe("")
  })

  it("handles a path that mixes both separators", () => {
    expect(fsBaseName("C:\\work/repo")).toBe("repo")
    expect(fsBaseName("C:/work\\repo")).toBe("repo")
  })
})

describe("siblingFsPath", () => {
  it("places the name next to an ordinary directory", () => {
    expect(siblingFsPath("C:\\work\\repo", "repo-wt")).toBe("C:\\work\\repo-wt")
    expect(siblingFsPath("/home/me/repo", "repo-wt")).toBe("/home/me/repo-wt")
    expect(siblingFsPath("\\\\server\\share\\repo", "repo-wt")).toBe(
      "\\\\server\\share\\repo-wt"
    )
  })

  // Roots have no sibling. The result must still be ABSOLUTE: git resolves a
  // bare relative worktree target inside the repository, and the folder that
  // gets registered afterwards would carry that unresolved string as its cwd.
  it("falls back to inside the root rather than emitting a relative path", () => {
    expect(siblingFsPath("C:\\", "repo-wt")).toBe("C:\\repo-wt")
    expect(siblingFsPath("C:", "repo-wt")).toBe("C:\\repo-wt")
    expect(siblingFsPath("/", "repo-wt")).toBe("/repo-wt")
    // A literal sibling of a share root would address a different share.
    expect(siblingFsPath("\\\\server\\share", "repo-wt")).toBe(
      "\\\\server\\share\\repo-wt"
    )
  })
})
