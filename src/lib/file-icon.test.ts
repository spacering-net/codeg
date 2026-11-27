import { describe, expect, it } from "vitest"

import { getFileIconName } from "./file-icon"

describe("getFileIconName", () => {
  it("maps extensions", () => {
    expect(getFileIconName("app.ts")).toBe("material-icon-theme:typescript")
    expect(getFileIconName("main.rs")).toBe("material-icon-theme:rust")
    expect(getFileIconName("a/b/c/mod.py")).toBe("material-icon-theme:python")
    expect(getFileIconName("photo.PNG")).toBe("material-icon-theme:image")
  })

  it("maps exact basenames", () => {
    expect(getFileIconName("Dockerfile")).toBe("material-icon-theme:docker")
    expect(getFileIconName(".gitignore")).toBe("material-icon-theme:git")
    expect(getFileIconName("pnpm-lock.yaml")).toBe("material-icon-theme:pnpm")
    expect(getFileIconName("project/tsconfig.json")).toBe(
      "material-icon-theme:tsconfig"
    )
  })

  it("maps config prefixes", () => {
    expect(getFileIconName("next.config.ts")).toBe("material-icon-theme:next")
    expect(getFileIconName("tailwind.config.js")).toBe(
      "material-icon-theme:tailwindcss"
    )
    expect(getFileIconName(".env.local")).toBe("material-icon-theme:key")
  })

  it("maps react tsx and declaration files", () => {
    expect(getFileIconName("App.tsx")).toBe("material-icon-theme:react-ts")
    expect(getFileIconName("types.d.ts")).toBe(
      "material-icon-theme:typescript-def"
    )
  })

  it("returns null for unknown files", () => {
    expect(getFileIconName("data.wasm")).toBeNull()
    expect(getFileIconName("Makefile2")).toBeNull()
  })
})
