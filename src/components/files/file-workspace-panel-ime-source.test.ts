import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createElement } from "react"
import { render, waitFor } from "@testing-library/react"
import MonacoEditor, { loader, type Monaco } from "@monaco-editor/react"

import { describe, expect, it, vi } from "vitest"
import { URI } from "monaco-editor/base/common/uri.js"
import { buildMonacoModelPath } from "@/lib/monaco-model-path"
import {
  MonacoModelProvider,
  useTrackMonacoModel,
} from "@/contexts/monaco-model-context"

const panelSource = readFileSync(
  resolve(process.cwd(), "src/components/files/file-workspace-panel.tsx"),
  "utf8"
)

describe("file-workspace-panel IME composition guard wiring", () => {
  it("scopes the guard to the Monaco model and binds the mounted editor", () => {
    expect(panelSource).toMatch(
      /useImeSafeEditorValue\([\s\S]{0,100}renderedContent,[\s\S]{0,100}activeScope,[\s\S]{0,100}handleCompositionChange/
    )
    expect(panelSource).toMatch(/bindImeEditor\(editorInstance\)/)
  })

  it("keeps a creation value while withholding controlled file content during composition", () => {
    expect(panelSource).toMatch(/defaultValue=\{renderedContent\}/)
    expect(panelSource).toMatch(
      /value=\{isFileTab \? imeSafeEditorValue : renderedContent\}/
    )
  })

  it("uses a stable change callback so Monaco does not rebind it per keystroke", () => {
    expect(panelSource).toMatch(
      /const handleEditorChange: OnChange = useCallback/
    )
    expect(panelSource).toMatch(/onChange=\{handleEditorChange\}/)
  })

  it("binds content and composition state to the originating file tab", () => {
    expect(panelSource).toMatch(
      /updateFileTabContent\(activeScope, value \?\? ""\)/
    )
    expect(panelSource).toMatch(
      /monacoRef\.current\?\.Uri\.parse\([\s\S]{0,40}editorModelPath[\s\S]{0,40}\)\.toString\(\)/
    )
    expect(panelSource).toMatch(/setFileTabComposing\(tabId, composing\)/)
    expect(panelSource).toMatch(
      /fileSaveState !== "idle" \|\|[\s\S]{0,30}isComposing/
    )
  })
})

it("retains scoped-out models and their undo stacks until their buffers close", () => {
  expect(panelSource).toContain(
    "trackMonacoModel(editorModelPath, editorMonaco)"
  )
  expect(panelSource).toContain("keepCurrentModel={true}")
  const workspaceSource = readFileSync(
    resolve(process.cwd(), "src/contexts/workspace-context.tsx"),
    "utf8"
  )
  expect(workspaceSource).toContain("<MonacoModelProvider fileTabs={fileTabs}>")
})

it("retains the first ordinary-mode model when tabs start following the folder and its editor hides", async () => {
  const tab = { id: "a", path: "/repo/a.ts" }
  const path = buildMonacoModelPath(tab.path, tab.id)
  const history = ["saved", "unsaved edit"]
  let attached = false
  const model = {
    uri: URI.parse(path),
    isAttachedToEditor: () => attached,
    dispose: vi.fn(() => {
      history.length = 0
    }),
    undo: () => {
      history.pop()
      return history[history.length - 1]
    },
  }
  const editor = {
    getModel: () => model,
    updateOptions: vi.fn(),
    restoreViewState: vi.fn(),
    saveViewState: vi.fn(),
    dispose: vi.fn(() => {
      attached = false
    }),
  }
  const create = vi.fn(() => {
    attached = true
    return editor
  })
  // Use the real React wrapper, replacing only the browser editor engine.
  // In particular its mount-only unmount callback remains unchanged.
  loader.config({
    monaco: {
      Uri: URI,
      editor: {
        getModel: () => model,
        create,
        setTheme: vi.fn(),
        onDidChangeMarkers: () => ({ dispose: vi.fn() }),
      },
    } as unknown as Monaco,
  })
  function TrackedEditor({ tabsFollowFolder }: { tabsFollowFolder: boolean }) {
    const track = useTrackMonacoModel()
    return createElement(MonacoEditor, {
      path,
      keepCurrentModel: true,
      onMount: (_, monaco) => track(path, monaco),
      wrapperProps: { "data-mode": tabsFollowFolder ? "scoped" : "normal" },
    })
  }
  const view = (tabsFollowFolder: boolean, visible = true, fileTabs = [tab]) =>
    createElement(
      MonacoModelProvider,
      { fileTabs },
      visible ? createElement(TrackedEditor, { tabsFollowFolder }) : null
    )
  const mounted = render(view(false))
  await waitFor(() => expect(create).toHaveBeenCalledOnce())
  mounted.rerender(view(true))
  mounted.rerender(view(true, false))
  expect(editor.dispose).toHaveBeenCalledOnce()

  expect(model.dispose).not.toHaveBeenCalled()
  expect(editor.getModel()).toBe(model)
  expect(model.undo()).toBe("saved")

  // The panel stays unmounted when the last buffer is subsequently closed.
  mounted.rerender(view(true, false, []))
  expect(model.dispose).toHaveBeenCalledOnce()
})
