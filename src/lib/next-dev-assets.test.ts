import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next-intl/plugin", () => ({
  default: () => (config: unknown) => config,
}))

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("TAURI_DEV_HOST", "localhost")
  vi.stubEnv("NODE_ENV", "development")
})

afterEach(() => vi.unstubAllEnvs())

describe("开发资源地址", () => {
  it("跟随 Next 实际监听的端口", async () => {
    vi.stubEnv("PORT", "3107")
    const { default: config } = await import("../../next.config")
    expect(config.assetPrefix).toBe("http://localhost:3107")
  })

  it("未指定端口时保持 3000", async () => {
    vi.stubEnv("PORT", "")
    const { default: config } = await import("../../next.config")
    expect(config.assetPrefix).toBe("http://localhost:3000")
  })

  it("生产静态导出不设置开发资源前缀", async () => {
    vi.stubEnv("PORT", "3107")
    vi.stubEnv("NODE_ENV", "production")
    const { default: config } = await import("../../next.config")
    expect(config.assetPrefix).toBeUndefined()
  })
})
