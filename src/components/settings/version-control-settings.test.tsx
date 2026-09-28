import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  detectGit: vi.fn(),
  getGitSettings: vi.fn(),
  updateGitSettings: vi.fn(),
  testGitPath: vi.fn(),
  getGitHubAccounts: vi.fn(),
  updateGitHubAccounts: vi.fn(),
  validateGitHubToken: vi.fn(),
  validateGitLabToken: vi.fn(),
  validateGiteaToken: vi.fn(),
  getAccountToken: vi.fn(),
  deleteAccountToken: vi.fn(),
  saveAccountToken: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { VersionControlSettings } from "./version-control-settings"
import enMessages from "@/i18n/messages/en.json"
import { detectGit, getGitSettings, getGitHubAccounts } from "@/lib/api"
import type { GitHubAccount } from "@/lib/types"

const mockDetectGit = vi.mocked(detectGit)
const mockGetGitSettings = vi.mocked(getGitSettings)
const mockGetGitHubAccounts = vi.mocked(getGitHubAccounts)

function account(overrides: Partial<GitHubAccount> = {}): GitHubAccount {
  return {
    id: "acc-1",
    server_url: "https://gitlab.example.com",
    username: "feitao",
    scopes: ["api"],
    avatar_url: null,
    is_default: false,
    created_at: "2026-08-22T01:28:18.613Z",
    provider: "gitlab",
    ...overrides,
  }
}

function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <VersionControlSettings />
    </NextIntlClientProvider>
  )
}

describe("VersionControlSettings account avatars", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectGit.mockResolvedValue({
      installed: true,
      version: "git version 2.39.0",
      path: "/usr/bin/git",
    })
    mockGetGitSettings.mockResolvedValue({ custom_path: null })
  })

  /**
   * The bug this pins: GitLab reports an avatar for every user whether or not
   * one was ever uploaded — for the rest it hands out a third-party
   * gravatar.com URL, which plenty of networks cannot reach. The row used to
   * treat "has a URL" as "will render a picture" and drew the initial only
   * when the URL was absent, so an unreachable avatar left an empty circle
   * with nothing in it at all.
   */
  it("falls back to the username initial when the avatar image does not load", async () => {
    mockGetGitHubAccounts.mockResolvedValue({
      accounts: [
        account({
          avatar_url:
            "https://www.gravatar.com/avatar/d02859952a42d0ece18c424a5b1e5cac?s=80&d=identicon",
        }),
      ],
    })

    renderWithIntl()

    // jsdom never loads images, which is exactly the state a blocked or
    // login-walled avatar host leaves the real webview in.
    await waitFor(() => expect(screen.getByText("F")).toBeInTheDocument())
  })

  it("shows the username initial for an account with no avatar at all", async () => {
    mockGetGitHubAccounts.mockResolvedValue({
      accounts: [
        account({
          id: "acc-2",
          server_url: "https://github.com",
          username: "octocat",
          provider: "github",
          avatar_url: null,
        }),
      ],
    })

    renderWithIntl()

    await waitFor(() => expect(screen.getByText("O")).toBeInTheDocument())
  })

  it("keeps a placeholder for a username whose first character is astral", async () => {
    mockGetGitHubAccounts.mockResolvedValue({
      accounts: [account({ username: "𝒥ane", avatar_url: null })],
    })

    renderWithIntl()

    // Indexing with [0] would have split the surrogate pair and rendered a
    // replacement glyph instead of a letter.
    await waitFor(() => expect(screen.getByText("𝒥")).toBeInTheDocument())
  })
})

describe("VersionControlSettings forge sections", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectGit.mockResolvedValue({
      installed: true,
      version: "git version 2.39.0",
      path: "/usr/bin/git",
    })
    mockGetGitSettings.mockResolvedValue({ custom_path: null })
  })

  /**
   * A declared Gitea account has to land in the Gitea section and NOWHERE else.
   * The section that would otherwise swallow it is the plain-git one at the
   * bottom — a catch-all defined by what the forge sections leave behind — and
   * an account filed there loses the two actions only a forge account gets
   * (test the token against the API, rotate it in place).
   */
  it("files a declared Gitea account under Gitea, not among the plain git credentials", async () => {
    mockGetGitHubAccounts.mockResolvedValue({
      accounts: [
        account({
          id: "acc-gitea",
          server_url: "https://git.corp.example",
          username: "tea",
          provider: "gitea",
          avatar_url: null,
        }),
      ],
    })

    renderWithIntl()

    await waitFor(() =>
      expect(screen.getByText("Gitea accounts")).toBeInTheDocument()
    )
    // The empty-state of the section it must NOT be in, which is only rendered
    // when that section really has nothing.
    expect(
      screen.getByText("No Git server accounts configured.")
    ).toBeInTheDocument()
    // …and the Gitea section's own empty-state is gone, because the account
    // is in it.
    expect(screen.queryByText("No Gitea account yet")).not.toBeInTheDocument()
  })

  it("shows an empty Gitea section when nothing is configured for it", async () => {
    mockGetGitHubAccounts.mockResolvedValue({ accounts: [] })

    renderWithIntl()

    await waitFor(() =>
      expect(screen.getByText("No Gitea account yet")).toBeInTheDocument()
    )
  })
})
