import { describe, expect, it } from "vitest"

import {
  definitionSecrets,
  hasSecrets,
  isSecretArg,
  isSecretEntry,
  isSecretName,
  MASK,
  maskArg,
  maskDefinition,
  maskUrl,
  urlHasSecret,
} from "./secrets"

describe("which values are secret", () => {
  it.each([
    "API_KEY",
    "GITHUB_TOKEN",
    "client_secret",
    "DB_PASSWORD",
    "passwd",
    "AWS_CREDENTIALS",
    "Authorization",
    "authorization",
    "Proxy-Authorization",
    "X-Api-Key",
    "Cookie",
  ])("%s is secret by its name", (name) => {
    expect(isSecretName(name)).toBe(true)
  })

  it.each(["PATH", "LOG_LEVEL", "Accept", "Content-Type", "HOME"])(
    "%s is not",
    (name) => {
      expect(isSecretName(name)).toBe(false)
    }
  )

  it("knows a token by its look, whatever it is called", () => {
    expect(isSecretEntry("GH", "ghp_abcdefghijklmnop")).toBe(true)
    expect(isSecretEntry("OPENAI", "sk-proj-123")).toBe(true)
    expect(isSecretEntry("MODE", "debug")).toBe(false)
  })
})

describe("arguments", () => {
  const args = [
    "-y",
    "server",
    "--api-key=abc123",
    "--token",
    "xyz",
    "--header",
    "Authorization: Bearer t0k3n",
    "--port",
    "8080",
  ]

  it("masks the value of a secret flag, the argument after one, and a header's value", () => {
    expect(args.map((_, index) => maskArg(args, index))).toEqual([
      "-y",
      "server",
      `--api-key=${MASK}`,
      "--token",
      MASK,
      "--header",
      `Authorization: ${MASK}`,
      "--port",
      "8080",
    ])
  })

  it("leaves everything else alone", () => {
    expect(isSecretArg(args, 0)).toBe(false)
    expect(isSecretArg(args, 8)).toBe(false)
    expect(isSecretArg(["https://example.com"], 0)).toBe(false)
  })
})

describe("addresses", () => {
  it("masks a password and secret query values, and nothing else", () => {
    expect(
      maskUrl("https://user:hunter2@mcp.example.com/sse?api_key=s3&x=1")
    ).toBe(`https://user:${MASK}@mcp.example.com/sse?api_key=${MASK}&x=1`)
    expect(urlHasSecret("https://mcp.example.com/mcp?region=eu")).toBe(false)
    expect(maskUrl("https://mcp.example.com/mcp?region=eu")).toBe(
      "https://mcp.example.com/mcp?region=eu"
    )
  })
})

describe("whole definitions", () => {
  it("names the secret values and masks every one of them", () => {
    const definition = {
      type: "http" as const,
      url: "https://a.test/mcp?token=abc",
      headers: { Authorization: "Bearer x", Accept: "application/json" },
    }
    expect(definitionSecrets(definition)).toEqual({
      names: ["Authorization"],
      args: false,
      url: true,
    })
    expect(maskDefinition(definition)).toEqual({
      type: "http",
      url: `https://a.test/mcp?token=${MASK}`,
      headers: { Authorization: MASK, Accept: "application/json" },
    })
  })

  it("has none in a plain local server", () => {
    expect(
      hasSecrets({ type: "stdio", command: "npx", args: ["-y", "x"] })
    ).toBe(false)
  })
})
