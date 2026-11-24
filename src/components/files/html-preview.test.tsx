import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import type { BrowserCapabilities } from "@/lib/browser/types"

const mocks = vi.hoisted(() => ({
  capabilities: null as BrowserCapabilities | null,
  remoteDesktop: false,
}))

vi.mock(import("@/lib/transport"), async (importOriginal) => ({
  ...(await importOriginal()),
  isRemoteDesktopMode: () => mocks.remoteDesktop,
}))

vi.mock("@/lib/browser/use-browser-capabilities", () => ({
  useBrowserCapabilities: () => mocks.capabilities,
}))
vi.mock("@/components/files/doc-guest-preview", () => ({
  DocGuestPreview: ({ onUseInline }: { onUseInline: () => void }) => (
    <div data-testid="doc-guest">
      <button type="button" onClick={onUseInline}>
        inline please
      </button>
    </div>
  ),
}))
vi.mock("@/lib/api", () => ({
  readWorkspaceFileBase64: () => Promise.resolve(""),
}))

import enMessages from "@/i18n/messages/en.json"

import {
  HtmlPreview,
  resetHtmlPreviewEngineOverridesForTests,
} from "./html-preview"
import {
  resetBrowserPrefsForTests,
  setBrowserHtmlPreviewEngine,
} from "@/lib/browser/browser-prefs"

const CAPS: BrowserCapabilities = {
  available: true,
  surface: "child",
  platform: "macos",
  channel: "native",
  reasons: [],
  isolatedStorage: true,
  proxy: { url: null, applies: "live", reason: null },
  downloadsDir: "/Users/dev/Downloads",
  policy: { enabled: true, managedRules: [], managedSource: null },
  docGuest: true,
  profiles: true,
  signInUserAgent: true,
  ownedWindowControls: false,
  remoteEgress: false,
}

function tab(id = "file:%2Ftmp%2Fa.html"): FileWorkspaceTab {
  return {
    id,
    kind: "file",
    folderId: null,
    title: "a.html",
    description: null,
    path: "/tmp/a.html",
    language: "html",
    content: "<!doctype html><title>Hello</title><p>hi</p>",
    loading: false,
  }
}

function renderPreview(t = tab()) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HtmlPreview tab={t} rootPath={null} />
    </NextIntlClientProvider>
  )
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe("HtmlPreview engine choice", () => {
  beforeEach(() => {
    resetBrowserPrefsForTests()
    resetHtmlPreviewEngineOverridesForTests()
    mocks.capabilities = CAPS
    mocks.remoteDesktop = false
  })

  // The document viewer reads the path off THIS computer's disk; a remote
  // workspace's file is on the remote host, and only the inline preview reads
  // it (through the server).
  it("keeps to the inline renderer in a remote workspace window", async () => {
    mocks.remoteDesktop = true
    renderPreview()
    await flush()
    expect(screen.queryByTestId("doc-guest")).not.toBeInTheDocument()
    expect(screen.getByTitle("HTML preview")).toBeInTheDocument()
    expect(
      screen.queryByLabelText("Use built-in browser preview")
    ).not.toBeInTheDocument()
  })

  it("renders the document guest where the backend offers one", () => {
    renderPreview()
    expect(screen.getByTestId("doc-guest")).toBeInTheDocument()
    expect(screen.queryByTitle("HTML preview")).not.toBeInTheDocument()
  })

  it("falls back to the inline renderer without a guest, with no way to switch", async () => {
    mocks.capabilities = { ...CAPS, docGuest: false }
    renderPreview()
    await flush()
    expect(screen.getByTitle("HTML preview")).toBeInTheDocument()
    expect(
      screen.queryByLabelText("Use built-in browser preview")
    ).not.toBeInTheDocument()
  })

  it("treats an unknown answer as no guest", async () => {
    mocks.capabilities = null
    renderPreview()
    await flush()
    expect(screen.getByTitle("HTML preview")).toBeInTheDocument()
    expect(screen.queryByTestId("doc-guest")).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText("Use built-in browser preview")
    ).not.toBeInTheDocument()
  })

  it("follows the setting, and a per-file choice made from the preview overrides it", async () => {
    setBrowserHtmlPreviewEngine("inline")
    renderPreview()
    await flush()
    expect(screen.getByTitle("HTML preview")).toBeInTheDocument()

    // The inline header offers the guest; the guest's menu offers inline.
    fireEvent.click(screen.getByLabelText("Use built-in browser preview"))
    expect(screen.getByTestId("doc-guest")).toBeInTheDocument()
    fireEvent.click(screen.getByText("inline please"))
    await flush()
    expect(screen.getByTitle("HTML preview")).toBeInTheDocument()
    expect(screen.queryByTestId("doc-guest")).not.toBeInTheDocument()
  })

  it("keeps the per-file choice across mounts, per file", async () => {
    renderPreview().unmount()
    const first = renderPreview()
    fireEvent.click(screen.getByText("inline please"))
    await flush()
    expect(screen.getByTitle("HTML preview")).toBeInTheDocument()
    first.unmount()
    // Same file again: still inline. Another file: the default (guest).
    renderPreview()
    await flush()
    expect(screen.getByTitle("HTML preview")).toBeInTheDocument()
    renderPreview(tab("file:%2Ftmp%2Fb.html"))
    expect(screen.getByTestId("doc-guest")).toBeInTheDocument()
  })
})
