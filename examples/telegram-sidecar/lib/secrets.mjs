// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Project root (the directory holding package.json / bot.mjs). */
export const PROJECT_ROOT = path.resolve(__dirname, "..")

/** Resolve an operator-owned secrets directory outside the source checkout. */
export function resolveSecretsDir(env = process.env) {
  if (env.CODEG_TG_SECRETS_DIR) return env.CODEG_TG_SECRETS_DIR
  // MGSecrets compatibility: an existing secrets root can keep its old layout.
  if (env.MG_SECRETS_DIR) return path.join(env.MG_SECRETS_DIR, "codeg-tg-bot")
  const userHome = os.homedir()
  const configHome =
    process.platform === "win32"
      ? env.APPDATA || path.join(userHome, "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(userHome, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || path.join(userHome, ".config")
  return path.join(configHome, "codeg", "telegram-sidecar", "secrets")
}

export const DEFAULT_SECRETS_DIR = resolveSecretsDir()

/**
 * Config defaults are deliberately free of personal data:
 *  - `allowedUserIds: []` fails closed — no user is authorized until the operator
 *    names them in config.json or `CODEG_TG_ALLOWED_USER_IDS`.
 *  - The database path is unset; secrets default to the user's configuration
 *    directory and can be replaced with config or environment variables.
 *  - `stateFile` / `logFile` live under the project root's `run/`, not under `lib/`.
 */
export const DEFAULT_CONFIG = {
  codegUrl: "http://127.0.0.1:3080",
  codegDbPath: "",
  telegramTokenFile: path.join(DEFAULT_SECRETS_DIR, "telegram_token.txt"),
  codegTokenFile: path.join(DEFAULT_SECRETS_DIR, "codeg_token.txt"),
  allowedUserIds: [],
  telegramApiBase: "https://api.telegram.org",
  telegramProxy: "auto",
  pollTimeoutSec: 25,
  streamThrottleMs: 1200,
  maxMessageChars: 3800,
  stateFile: path.join(PROJECT_ROOT, "run", "state.json"),
  logFile: path.join(PROJECT_ROOT, "run", "bot.log"),
  proactiveWatchDesktop: true,
}

/** Parse `CODEG_TG_ALLOWED_USER_IDS="123,456"` (or a JSON array) into numbers. */
function parseIdList(raw) {
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  if (!text) return []
  const body = text.startsWith("[") ? text : `[${text}]`
  try {
    const parsed = JSON.parse(body)
    if (!Array.isArray(parsed)) return null
    return parsed
      .map((v) => Number(String(v).trim()))
      .filter((v) => Number.isFinite(v) && v !== 0)
  } catch {
    return text
      .split(/[,\s]+/)
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v !== 0)
  }
}

/**
 * Load config from `--config=<path>`, `CODEG_TG_BOT_CONFIG`, or `<root>/config.json`.
 *
 * Environment variables (highest priority):
 *   CODEG_TG_CODEG_URL, CODEG_TG_DB_PATH, CODEG_TG_STATE_FILE, CODEG_TG_LOG_FILE,
 *   CODEG_TG_ALLOWED_USER_IDS, CODEG_TG_BOT_CONFIG,
 *   CODEG_TG_TELEGRAM_TOKEN_FILE, CODEG_TG_CODEG_TOKEN_FILE, CODEG_TG_SECRETS_DIR
 */
export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const argCfg = argv.find((a) => a.startsWith("--config="))
  const cfgPath = argCfg
    ? argCfg.slice("--config=".length)
    : env.CODEG_TG_BOT_CONFIG || path.join(PROJECT_ROOT, "config.json")

  let loaded = {}
  try {
    const raw = fs.readFileSync(cfgPath, "utf8")
    loaded = JSON.parse(raw)
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read config (${cfgPath}): ${err.message}`)
    }
  }

  const cfg = {
    ...DEFAULT_CONFIG,
    telegramTokenFile: path.join(resolveSecretsDir(env), "telegram_token.txt"),
    codegTokenFile: path.join(resolveSecretsDir(env), "codeg_token.txt"),
    ...loaded,
    configPath: cfgPath,
  }

  if (env.CODEG_TG_CODEG_URL) cfg.codegUrl = env.CODEG_TG_CODEG_URL
  if (env.CODEG_TG_DB_PATH) cfg.codegDbPath = env.CODEG_TG_DB_PATH
  if (env.CODEG_TG_STATE_FILE) cfg.stateFile = env.CODEG_TG_STATE_FILE
  if (env.CODEG_TG_LOG_FILE) cfg.logFile = env.CODEG_TG_LOG_FILE
  if (env.CODEG_TG_TELEGRAM_TOKEN_FILE)
    cfg.telegramTokenFile = env.CODEG_TG_TELEGRAM_TOKEN_FILE
  if (env.CODEG_TG_CODEG_TOKEN_FILE)
    cfg.codegTokenFile = env.CODEG_TG_CODEG_TOKEN_FILE
  if (env.CODEG_TG_TELEGRAM_API_BASE)
    cfg.telegramApiBase = env.CODEG_TG_TELEGRAM_API_BASE
  if (env.CODEG_TG_TELEGRAM_PROXY !== undefined)
    cfg.telegramProxy = env.CODEG_TG_TELEGRAM_PROXY

  const envIds = parseIdList(env.CODEG_TG_ALLOWED_USER_IDS)
  if (envIds !== null) cfg.allowedUserIds = envIds

  // Fail closed: never inherit a non-array / non-numeric allow list.
  cfg.allowedUserIds = Array.isArray(cfg.allowedUserIds)
    ? cfg.allowedUserIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id !== 0)
    : []

  return cfg
}

/**
 * Read first non-empty, non-comment line from a secret file.
 */
function readSecretFile(filePath) {
  if (!filePath) return ""
  try {
    const raw = fs.readFileSync(filePath, "utf8")
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith("#")) {
        return trimmed
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(
        `Failed reading secret file (${filePath}): ${err.message}`
      )
    }
  }
  return ""
}

/**
 * Load Telegram Bot token following MGSecrets priority:
 * 1) cfg.telegramTokenFile (default: operator's secrets directory)
 * 2) CODEG_TG_BOT_TOKEN env var
 * 3) project-local run/telegram_token.txt fallback
 */
// MGSecrets
export function loadTelegramToken(cfg, env = process.env) {
  const primary = readSecretFile(cfg.telegramTokenFile)
  if (primary) return primary

  const fromEnv = (env.CODEG_TG_BOT_TOKEN || "").trim()
  if (fromEnv) return fromEnv

  const localFallback = readSecretFile(
    path.join(PROJECT_ROOT, "run", "telegram_token.txt")
  )
  if (localFallback) return localFallback

  throw new Error(
    `Missing Telegram Bot token. Save your @BotFather token to ${cfg.telegramTokenFile || "(unset telegramTokenFile)"} (or set CODEG_TG_BOT_TOKEN).`
  )
}

/**
 * Resolve the Codeg SQLite path when none was configured, using the documented
 * per-platform location of the desktop app's database. Returns '' when unknown.
 */
function guessCodegDbPath() {
  const home = os.homedir()
  const candidates = [
    // Windows
    path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "app.codeg",
      "codeg.db"
    ),
    // macOS
    path.join(home, "Library", "Application Support", "app.codeg", "codeg.db"),
    // Linux (XDG)
    path.join(
      process.env.XDG_DATA_HOME || path.join(home, ".local", "share"),
      "app.codeg",
      "codeg.db"
    ),
  ]
  return candidates.find((p) => fs.existsSync(p)) || ""
}

/**
 * Load Codeg Web Service token following MGSecrets priority:
 * 1) cfg.codegTokenFile (default: operator's secrets directory)
 * 2) CODEG_WEB_TOKEN env var
 * 3) Read-only SQLite lookup from codeg.db app_metadata (web_service_token)
 *
 * Returns '' when no source is configured — callers degrade to unauthenticated
 * requests instead of crashing, matching the previous behaviour.
 */
// MGSecrets
export function loadCodegToken(cfg, env = process.env) {
  const primary = readSecretFile(cfg.codegTokenFile)
  if (primary) return primary

  const fromEnv = (env.CODEG_WEB_TOKEN || "").trim()
  if (fromEnv) return fromEnv

  const dbPath = cfg.codegDbPath || guessCodegDbPath()
  if (!dbPath || !fs.existsSync(dbPath)) return ""

  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db
      .prepare("SELECT value FROM app_metadata WHERE key = 'web_service_token'")
      .get()
    if (row && typeof row.value === "string" && row.value.trim()) {
      return row.value.trim()
    }
  } catch (err) {
    throw new Error(
      `Failed reading web_service_token from ${dbPath}: ${err.message}`
    )
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close failure on read-only handle
    }
  }

  return ""
}

/**
 * Resolve Telegram proxy URL. `'auto'` inspects standard proxy env vars;
 * empty string disables proxying. No hard-coded local proxy port is assumed.
 */
export function resolveTelegramProxy(cfg, env = process.env) {
  const raw = String(cfg.telegramProxy ?? "auto").trim()
  if (!raw) return ""
  if (raw.toLowerCase() === "auto") {
    return (
      env.HTTPS_PROXY ||
      env.https_proxy ||
      env.HTTP_PROXY ||
      env.http_proxy ||
      ""
    ).trim()
  }
  return raw
}
