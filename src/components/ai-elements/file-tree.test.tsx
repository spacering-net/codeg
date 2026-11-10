import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveFileTreeDropZone } from "@/lib/file-tree-dnd"

import { FileTree, FileTreeFile, FileTreeFolder } from "./file-tree"

function renderTree(keyboardNavigation: boolean) {
  return render(
    <FileTree
      keyboardNavigation={keyboardNavigation}
      expanded={new Set(["dir"])}
      selectedPath="dir"
    >
      <FileTreeFolder path="dir" name="dir" depth={0}>
        <FileTreeFile path="dir/file.ts" name="file.ts" depth={1} />
      </FileTreeFolder>
    </FileTree>
  )
}

describe("FileTree keyboard focus topology", () => {
  it("collapses the opted-in tree to a single tab stop: only the container", () => {
    renderTree(true)

    const container = screen.getByRole("tree")
    const [folderItem, fileItem] = screen.getAllByRole("treeitem")
    const folderButton = screen.getByRole("button", { name: "dir" })

    // The container is the sole focus host...
    expect(container.tabIndex).toBe(0)
    // ...and every row — including the folder's native <button> header, which
    // would otherwise remain a default tab stop — is out of the tab order.
    expect(folderItem.tabIndex).toBe(-1)
    expect(folderButton.tabIndex).toBe(-1)
    expect(fileItem.tabIndex).toBe(-1)
  })

  it("points aria-activedescendant at the selected row's id", () => {
    renderTree(true)

    const container = screen.getByRole("tree")
    const [folderItem] = screen.getAllByRole("treeitem")

    expect(folderItem.id).toBeTruthy()
    expect(container).toHaveAttribute("aria-activedescendant", folderItem.id)
  })

  it("leaves per-row tab stops unchanged when keyboard navigation is off", () => {
    renderTree(false)

    const container = screen.getByRole("tree")
    const [folderItem, fileItem] = screen.getAllByRole("treeitem")
    const folderButton = screen.getByRole("button", { name: "dir" })

    // Unchanged legacy behavior: rows are individually focusable and the
    // container is not a virtual-focus host.
    expect(folderItem.tabIndex).toBe(0)
    expect(folderButton.tabIndex).toBe(0)
    expect(fileItem.tabIndex).toBe(0)
    expect(container).not.toHaveAttribute("aria-activedescendant")
  })
})

describe("FileTree row chrome", () => {
  it("leaves a directory with the chevron as its only glyph", () => {
    // The chevron already says "directory" AND expanded/collapsed; a folder
    // icon beside it is a second copy of the same information.
    const { container } = renderTree(false)

    expect(container.querySelector(".lucide-folder")).toBeNull()
    expect(container.querySelector(".lucide-folder-open")).toBeNull()
    expect(
      screen
        .getByRole("button", { name: "dir" })
        .querySelector(".lucide-chevron-right")
    ).not.toBeNull()
  })

  it("puts a file's icon in the same leading column as a folder's chevron", () => {
    // Folder rows read [chevron][name] and file rows [icon][name]. A spacer in
    // front of the file icon (which is what the folder icon used to line up
    // with) would push every file name one glyph right of its sibling
    // directory's.
    renderTree(false)
    const [, fileItem] = screen.getAllByRole("treeitem")

    expect(
      fileItem.firstElementChild?.querySelector(".lucide-file")
    ).not.toBeNull()
  })

  it("indents one glyph width (1rem) per nesting level", () => {
    // Narrow panels are the file tree's home, so a level costs exactly one
    // leading-glyph column. jsdom folds the row's
    // `calc(<depth> * 1rem + 0.5rem)` down to a single term, which is why the
    // expectations read as the already-summed values.
    render(
      <FileTree expanded={new Set(["dir", "dir/sub"])}>
        <FileTreeFolder path="dir" name="dir" depth={0}>
          <FileTreeFolder path="dir/sub" name="sub" depth={1}>
            <FileTreeFile path="dir/sub/file.ts" name="file.ts" depth={2} />
          </FileTreeFolder>
        </FileTreeFolder>
      </FileTree>
    )

    expect(screen.getByRole("button", { name: "dir" })).toHaveStyle({
      paddingLeft: "calc(0.5rem)",
    })
    expect(screen.getByRole("button", { name: "sub" })).toHaveStyle({
      paddingLeft: "calc(1.5rem)",
    })
    const fileRow = screen
      .getAllByRole("treeitem")
      .find((row) => row.textContent === "file.ts")
    expect(fileRow).toHaveStyle({ paddingLeft: "calc(2.5rem)" })
  })
})

describe("FileTree trailing row actions", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const onDragOver = vi.fn()

  function renderWithActions() {
    onDragOver.mockClear()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const view = render(
      <FileTree expanded={new Set(["dir"])}>
        <FileTreeFolder
          path="dir"
          name="dir"
          depth={0}
          dropTargetDir="dir"
          rowProps={{ draggable: true, onDragOver }}
          actions={
            <button type="button" aria-label="folder action">
              ⋯
            </button>
          }
        >
          <FileTreeFile
            path="dir/file.ts"
            name="file.ts"
            depth={1}
            actions={
              <button type="button" aria-label="file action">
                ⋯
              </button>
            }
          />
        </FileTreeFolder>
      </FileTree>
    )
    return { ...view, consoleError }
  }

  it("keeps the folder's action out of the header button", () => {
    // The folder header is a native <button>. HTML forbids a button inside a
    // button and React reports the nesting as a hydration error, so the action
    // must be a sibling — not a child — of the header.
    const { container, consoleError } = renderWithActions()

    expect(container.querySelector("button button")).toBeNull()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("leaves the folder header's accessible name to the folder alone", () => {
    // A nested action would be walked into the header's name computation, so
    // the row would announce as "dir ⋯" instead of "dir".
    renderWithActions()

    expect(screen.getByRole("button", { name: "dir" })).toBeInTheDocument()
  })

  it("renders both rows' actions", () => {
    renderWithActions()

    expect(screen.getByLabelText("folder action")).toBeInTheDocument()
    expect(screen.getByLabelText("file action")).toBeInTheDocument()
  })

  it("keeps the folder's drop zone covering the action", () => {
    // The action is a sibling of the header, so a drop zone left on the header
    // alone would stop at the action's edge: `resolveFileTreeDropZone` walks UP
    // from whatever the pointer hit, and would find nothing above it. Dropping
    // on the ⋯ strip of a destination folder would then silently do nothing.
    renderWithActions()
    const action = screen.getByLabelText("folder action")

    expect(resolveFileTreeDropZone(action)).toEqual({
      kind: "dir",
      destDir: "dir",
    })
  })

  it("still fires the row's drag handlers from over the action", () => {
    // Same hole on the web path, which uses the React dragover/drop handlers
    // rather than the coordinate hit-test.
    renderWithActions()

    fireEvent.dragOver(screen.getByLabelText("folder action"))

    expect(onDragOver).toHaveBeenCalledTimes(1)
  })

  it("keeps the folder header filling the row beside its action", () => {
    // The header no longer spans the row on its own (the action is a sibling),
    // so without `grow` it shrinks to its name and clicking the empty right
    // half of a folder row stops expanding it. jsdom has no layout, so this
    // pins the class; the width was measured in a browser (493px of a 525px
    // row — the rest is the action strip).
    renderWithActions()

    expect(screen.getByRole("button", { name: "dir" })).toHaveClass("grow")
  })

  it("dims the whole row, action included, from rowProps' className", () => {
    // `dragging && "opacity-70"` marks the row as the drag source; leaving it
    // on the header would dim everything but the ⋯.
    render(
      <FileTree expanded={new Set()}>
        <FileTreeFolder
          path="dir"
          name="dir"
          depth={0}
          rowProps={{ className: "opacity-70" }}
          actions={
            <button type="button" aria-label="dimmed action">
              ⋯
            </button>
          }
        />
      </FileTree>
    )

    const action = screen.getByLabelText("dimmed action")
    expect(action.closest(".opacity-70")).not.toBeNull()
  })

  it("publishes the row-hover group both rows' actions can reveal from", () => {
    // The action is hidden at rest and revealed on row hover; :hover only
    // propagates to ancestors, so the group has to sit on an element that
    // encloses BOTH the row content and the action.
    const { container } = renderWithActions()

    for (const action of [
      screen.getByLabelText("folder action"),
      screen.getByLabelText("file action"),
    ]) {
      const group = action.closest(".group\\/file-tree-row")
      expect(group).not.toBeNull()
      expect(container.contains(group)).toBe(true)
    }
  })
})
