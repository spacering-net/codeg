import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Every tree built on the `ai-elements/file-tree` primitives owes its rows ONE
// leading glyph column: a folder spends it on the chevron, a file on its type
// icon / status letter / checkbox. `file-tree.test.tsx` locks that for the
// primitive's own file row; this file locks it for the consumers that override
// `FileTreeFile`'s children and so have to honour the rule by hand.
//
// The regression these guard against: a blank `size-4` spacer in front of the
// real glyph. It cost a second column, so every file hung one glyph right of
// the directory it lives in, and a file sat right of its own sibling folder.
const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8")

const sources = {
  gitChanges: read("src/components/layout/aux-panel-git-changes-tab.tsx"),
  gitLog: read("src/components/layout/aux-panel-git-log-tab.tsx"),
  push: read("src/components/layout/push-workspace.tsx"),
  unstash: read("src/components/layout/unstash-dialog.tsx"),
  commitDialog: read("src/components/layout/commit-dialog.tsx"),
  fileTreeTab: read("src/components/layout/aux-panel-file-tree-tab.tsx"),
  breadcrumb: read("src/components/files/file-path-breadcrumb.tsx"),
}

describe("file tree rows keep a single leading glyph column", () => {
  it.each(Object.entries(sources))(
    "%s renders no blank leading spacer",
    (_name, source) => {
      expect(source).not.toMatch(/<span className="(?:size|w)-4 shrink-0" \/>/)
    }
  )

  it.each([
    ["gitChanges", sources.gitChanges],
    ["gitLog", sources.gitLog],
    ["push", sources.push],
  ] as const)("%s leads every change row with its status column", (_n, src) => {
    // The commit-file rows read [status?][icon][name]; CommitFileInfo holds all
    // three, so it must be the row's FIRST child (an optional JSX comment
    // aside) for the leading glyph to land in the chevron column.
    const rows = src.match(/<FileTreeFile\b/g) ?? []
    const leads =
      src.match(/<>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<CommitFileInfo\b/g) ?? []
    expect(rows.length).toBeGreaterThan(0)
    expect(leads).toHaveLength(rows.length)
  })

  it("gives unstash file rows the icon its folders spend on a chevron", () => {
    expect(sources.unstash).toMatch(/<FileTreeIcon>/)
  })

  it.each([
    ["commitDialog", sources.commitDialog],
    ["fileTreeTab", sources.fileTreeTab],
  ] as const)("%s leaves the row's own horizontal padding alone", (_n, src) => {
    // A checkbox row's `px-1.5` put it 2px inside the `pl-2` its sibling
    // folder header uses, and pulled the trailing status column 2px off the
    // folder's `pr-2`. The primitive's padding already matches both.
    expect(src).not.toMatch(/className="gap-1 px-1\.5 py-1"/)
  })
})
