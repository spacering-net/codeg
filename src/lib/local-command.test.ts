import { describe, expect, it, vi } from "vitest"
import type { FolderCommand } from "@/lib/types"

const h = vi.hoisted(() => ({
  remote: true,
  baseUrl: "https://devbox.example:3080/",
}))

vi.mock("@/lib/transport", () => ({
  isRemoteDesktopMode: () => h.remote,
  getServerBaseUrl: () => h.baseUrl,
}))

import { getRemoteHostName, isLocalCommand } from "./local-command"

function command(command: string, runLocal?: boolean): FolderCommand {
  return {
    id: 1,
    folder_id: 1,
    name: "x",
    command,
    sort_order: 0,
    ...(runLocal === undefined ? {} : { run_local: runLocal }),
    created_at: "",
    updated_at: "",
  }
}

describe("isLocalCommand", () => {
  it("follows the command's flag", () => {
    expect(isLocalCommand(command("zed .", true))).toBe(true)
    expect(isLocalCommand(command("pnpm dev", false))).toBe(false)
  })

  it("runs an older server's command, which has no flag, in a terminal", () => {
    expect(isLocalCommand(command("pnpm dev"))).toBe(false)
  })

  it("reads nothing into the command's text", () => {
    expect(isLocalCommand(command("local: zed ."))).toBe(false)
  })
})

describe("getRemoteHostName", () => {
  it("returns the remote server's host name", () => {
    h.remote = true
    expect(getRemoteHostName()).toBe("devbox.example")
  })

  it("is null outside a remote-desktop window", () => {
    h.remote = false
    expect(getRemoteHostName()).toBeNull()
  })
})
