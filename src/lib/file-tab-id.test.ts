import { describe, expect, it } from "vitest"
import {
  browserTabBackendId,
  buildFileTabId,
  parseFileTabId,
  type FileTabIdParts,
} from "@/lib/file-tab-id"

describe("file-tab-id build↔parse round-trip", () => {
  const cases: FileTabIdParts[] = [
    { kind: "file", path: "/repo/src/app.ts" },
    // Path containing the separator, spaces, and non-ASCII.
    { kind: "file", path: "/repo/weird:dir/文件 名.md" },
    // Windows drive path — the ":" must be token-encoded, never a separator.
    { kind: "file", path: "C:/work/repo/src/app.ts" },
    { kind: "diff-working-all", folderId: 3 },
    { kind: "diff-working", folderId: 3, path: "a/b.rs" },
    { kind: "diff-working-unified", folderId: 3, path: "a:colon.rs" },
    { kind: "diff-working-overview", folderId: 3, path: "." },
    { kind: "diff-branch", folderId: 7, branch: "feat/x:y", path: "src/a.ts" },
    { kind: "diff-branch", folderId: 7, branch: "main", path: null },
    {
      kind: "diff-branch-overview",
      folderId: 7,
      branch: "release/1.0",
      path: null,
    },
    { kind: "diff-commit", folderId: 2, commit: "abc1234def", path: null },
    { kind: "diff-commit", folderId: 2, commit: "abc1234def", path: "x/y.go" },
    {
      kind: "diff-session",
      folderId: 9,
      groupLabel: "Turn 3: fix & retry",
      path: "src/main.py",
    },
    { kind: "diff-external-conflict", path: "/repo/notes/读我.txt" },
  ]

  it.each(cases.map((parts) => [parts.kind, parts] as const))(
    "round-trips %s",
    (_kind, parts) => {
      const id = buildFileTabId(parts)
      expect(parseFileTabId(id)).toEqual(parts)
    }
  )

  it("gives one identity per absolute path — no folder namespacing", () => {
    const a = buildFileTabId({ kind: "file", path: "/repo1/src/app.ts" })
    const b = buildFileTabId({ kind: "file", path: "/repo2/src/app.ts" })
    const aAgain = buildFileTabId({ kind: "file", path: "/repo1/src/app.ts" })
    expect(a).not.toBe(b)
    expect(a).toBe(aAgain)
  })

  it("encodes Windows drive colons into two fixed segments", () => {
    const id = buildFileTabId({ kind: "file", path: "C:/work/x.ts" })
    expect(id.split(":")).toHaveLength(2)
  })

  it("does not confuse a path named 'all' with the null-path sentinel", () => {
    const withPath = buildFileTabId({
      kind: "diff-commit",
      folderId: 1,
      commit: "abc",
      path: "all",
    })
    const withoutPath = buildFileTabId({
      kind: "diff-commit",
      folderId: 1,
      commit: "abc",
      path: null,
    })
    expect(withPath).not.toBe(withoutPath)
    expect(parseFileTabId(withPath)).toMatchObject({ path: "all" })
    expect(parseFileTabId(withoutPath)).toMatchObject({ path: null })
  })

  it("rejects malformed and legacy (folder-namespaced) ids", () => {
    // Pre-unification format carried a folder segment: file:<folderId>:<path>.
    expect(parseFileTabId("file:1:a.ts")).toBeNull()
    expect(parseFileTabId("file:")).toBeNull()
    expect(parseFileTabId("file")).toBeNull()
    expect(parseFileTabId("diff:external-conflict:4:notes.txt")).toBeNull()
    expect(parseFileTabId("diff:external-conflict:")).toBeNull()
    expect(parseFileTabId("diff:working:all")).toBeNull()
    expect(parseFileTabId("diff:working::x")).toBeNull()
    expect(parseFileTabId("diff:unknown:1:x")).toBeNull()
    expect(parseFileTabId("diff:branch:1:main")).toBeNull()
    expect(parseFileTabId("")).toBeNull()
    expect(parseFileTabId("random")).toBeNull()
  })

  it("emits ids whose variable segments never contain a bare separator", () => {
    const id = buildFileTabId({
      kind: "diff-session",
      folderId: 5,
      groupLabel: "a:b:c",
      path: "d:e/f.ts",
    })
    // 2 fixed prefix segments + folderId + 2 encoded tokens = 5 segments.
    expect(id.split(":")).toHaveLength(5)
  })
})

describe("browser tab ids", () => {
  it("round-trips the backend tab id, including adopted popups", () => {
    for (const id of ["b7e2c1d0-1a2b-4c3d-9e8f-0a1b2c3d4e5f", "abc-p1", "t1"]) {
      const tabId = buildFileTabId({ kind: "browser", id })
      expect(tabId).toBe(`browser:${id}`)
      expect(parseFileTabId(tabId)).toEqual({ kind: "browser", id })
      expect(browserTabBackendId(tabId)).toBe(id)
    }
  })

  it("rejects malformed browser ids and non-browser tabs", () => {
    expect(parseFileTabId("browser:")).toBeNull()
    expect(parseFileTabId("browser:a:b")).toBeNull()
    expect(browserTabBackendId("file:%2Frepo%2Fa.ts")).toBeNull()
  })
})
