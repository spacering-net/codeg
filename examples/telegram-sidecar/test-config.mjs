// SPDX-License-Identifier: Apache-2.0
// Configuration / default-path / authorization regression tests.
// No real secret is read: every path here is a temp fixture.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  DEFAULT_CONFIG,
  PROJECT_ROOT,
  loadConfig,
  loadTelegramToken,
  resolveSecretsDir,
  resolveTelegramProxy,
} from "./lib/secrets.mjs"
import { CodegTgBot } from "./bot.mjs"
import { StateStore } from "./lib/state.mjs"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codeg-tg-cfg-"))
}

test("config: defaults are personal-data free and rooted at the project directory", () => {
  // Authorization fails closed.
  assert.deepEqual(DEFAULT_CONFIG.allowedUserIds, [])

  // No hard-coded Windows user profile / personal database path.
  assert.equal(DEFAULT_CONFIG.codegDbPath, "")

  // run/ defaults live under the project root, not under lib/.
  assert.equal(
    DEFAULT_CONFIG.stateFile,
    path.join(PROJECT_ROOT, "run", "state.json")
  )
  assert.equal(
    DEFAULT_CONFIG.logFile,
    path.join(PROJECT_ROOT, "run", "bot.log")
  )
  assert.ok(!DEFAULT_CONFIG.stateFile.includes(`${path.sep}lib${path.sep}`))
  assert.ok(
    fs.existsSync(path.join(PROJECT_ROOT, "package.json")),
    "PROJECT_ROOT holds package.json"
  )

  // Secrets stay optional: the loader must not invent a local proxy port.
  assert.equal(resolveTelegramProxy({ telegramProxy: "auto" }, {}), "")
})

test("config: environment variables override file values, including the allow list", () => {
  const dir = tmpDir()
  try {
    const cfgPath = path.join(dir, "config.json")
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        allowedUserIds: [111],
        codegUrl: "http://127.0.0.1:9999",
        stateFile: path.join(dir, "from-file.json"),
      }),
      "utf8"
    )

    const cfg = loadConfig([`--config=${cfgPath}`], {
      CODEG_TG_CODEG_URL: "http://127.0.0.1:4444",
      CODEG_TG_ALLOWED_USER_IDS: "222, 333",
      CODEG_TG_STATE_FILE: path.join(dir, "from-env.json"),
    })

    assert.equal(cfg.codegUrl, "http://127.0.0.1:4444")
    assert.deepEqual(cfg.allowedUserIds, [222, 333])
    assert.equal(cfg.stateFile, path.join(dir, "from-env.json"))
    assert.equal(cfg.configPath, cfgPath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("config: an empty or malformed allow list authorizes nobody (fail closed)", () => {
  const dir = tmpDir()
  try {
    const cfgPath = path.join(dir, "config.json")
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ allowedUserIds: "not-a-list" }),
      "utf8"
    )
    assert.deepEqual(loadConfig([`--config=${cfgPath}`], {}).allowedUserIds, [])

    fs.writeFileSync(cfgPath, JSON.stringify({}), "utf8")
    assert.deepEqual(loadConfig([`--config=${cfgPath}`], {}).allowedUserIds, [])

    // Explicitly clearing via env also fails closed.
    const cleared = loadConfig([`--config=${cfgPath}`], {
      CODEG_TG_ALLOWED_USER_IDS: "",
    })
    assert.deepEqual(cleared.allowedUserIds, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("config: a bot built from defaults refuses every user and every prompt", async () => {
  const dir = tmpDir()
  try {
    const cfgPath = path.join(dir, "config.json")
    fs.writeFileSync(cfgPath, JSON.stringify({}), "utf8")
    const cfg = loadConfig([`--config=${cfgPath}`], {})

    const sent = []
    const prompted = []
    const bot = new CodegTgBot({
      cfg,
      tg: {
        async sendMessage(chatId, text) {
          sent.push({ chatId, text })
          return { message_id: sent.length }
        },
        async answerCallbackQuery() {
          return true
        },
      },
      codeg: {
        on() {},
        acpPrompt: async (args) => prompted.push(args),
        acpListConnections: async () => [],
      },
      state: new StateStore(path.join(dir, "state.json")),
      logger: { info() {}, warn() {}, error() {} },
    })

    await bot.handleUpdate({
      message: {
        message_id: 1,
        from: { id: 424242 },
        chat: { id: 424242, type: "private" },
        text: "/help",
      },
    })
    await bot.handleUpdate({
      message: {
        message_id: 2,
        from: { id: 424242 },
        chat: { id: 424242, type: "private" },
        text: "hello",
      },
    })

    assert.equal(sent.length, 0, "no reply may be sent to an unauthorized user")
    assert.equal(prompted.length, 0, "no prompt may be forwarded")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("config: token loading keeps MGSecrets first, then env, then the project-local fallback", () => {
  const dir = tmpDir()
  try {
    const secretsFile = path.join(dir, "telegram_token.txt")
    fs.writeFileSync(secretsFile, "111:from-secrets-file\n", "utf8")

    assert.equal(
      loadTelegramToken({ telegramTokenFile: secretsFile }, {}),
      "111:from-secrets-file"
    )
    assert.equal(
      loadTelegramToken(
        { telegramTokenFile: secretsFile },
        { CODEG_TG_BOT_TOKEN: "222:from-env" }
      ),
      "111:from-secrets-file",
      "the secrets file wins over the environment"
    )
    assert.equal(
      loadTelegramToken(
        { telegramTokenFile: path.join(dir, "absent.txt") },
        { CODEG_TG_BOT_TOKEN: "222:from-env" }
      ),
      "222:from-env"
    )
    assert.throws(
      () =>
        loadTelegramToken(
          { telegramTokenFile: path.join(dir, "absent.txt") },
          {}
        ),
      /Missing Telegram Bot token/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("config: shipped config.example.json has no credentials and a documented empty allow list", () => {
  const examplePath = path.join(PROJECT_ROOT, "config.example.json")
  assert.ok(
    fs.existsSync(examplePath),
    "config.example.json must exist for new deployments"
  )
  const raw = fs.readFileSync(examplePath, "utf8")
  const example = JSON.parse(raw)

  assert.deepEqual(example.allowedUserIds, [])
  assert.doesNotMatch(raw, /\d{8,}:[A-Za-z0-9_-]{30,}/, "no bot token shape")
  assert.doesNotMatch(raw, /"codegToken"\s*:/i, "no inline codeg token field")
  assert.doesNotMatch(
    raw,
    /[A-Z]:\\|\/Users\/|\/home\//,
    "no deployment-specific path"
  )
})

test("config: explicit secrets directory wins over the compatible legacy root", () => {
  const dir = tmpDir()
  try {
    const secretDir = path.join(dir, "operator-secrets")
    const env = {
      CODEG_TG_SECRETS_DIR: secretDir,
      MG_SECRETS_DIR: path.join(dir, "legacy"),
    }
    assert.equal(resolveSecretsDir(env), secretDir)
    const cfg = loadConfig([`--config=${path.join(dir, "absent.json")}`], env)
    assert.equal(
      cfg.telegramTokenFile,
      path.join(secretDir, "telegram_token.txt")
    )
    assert.equal(cfg.codegTokenFile, path.join(secretDir, "codeg_token.txt"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("config: legacy secrets root and individual file overrides retain their priority", () => {
  const dir = tmpDir()
  try {
    const env = { MG_SECRETS_DIR: path.join(dir, "legacy") }
    assert.equal(
      resolveSecretsDir(env),
      path.join(dir, "legacy", "codeg-tg-bot")
    )
    const cfgPath = path.join(dir, "config.json")
    const configured = path.join(dir, "configured-token.txt")
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ telegramTokenFile: configured }),
      "utf8"
    )
    const cfg = loadConfig([`--config=${cfgPath}`], env)
    assert.equal(cfg.telegramTokenFile, configured)
    const overridden = path.join(dir, "overridden-token.txt")
    const overriddenCfg = loadConfig([`--config=${cfgPath}`], {
      ...env,
      CODEG_TG_TELEGRAM_TOKEN_FILE: overridden,
    })
    assert.equal(overriddenCfg.telegramTokenFile, overridden)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("config: .gitignore excludes runtime state, logs, real config and secrets", () => {
  const ignorePath = path.join(PROJECT_ROOT, ".gitignore")
  assert.ok(fs.existsSync(ignorePath), ".gitignore must exist")
  const lines = fs
    .readFileSync(ignorePath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))

  for (const expected of [
    "config.json",
    "run/",
    "*.log",
    "*.pid",
    "node_modules/",
  ]) {
    assert.ok(lines.includes(expected), `.gitignore must list ${expected}`)
  }
  // The example config must stay committed.
  assert.ok(!lines.includes("config.example.json"))
})
