import type { McpDefinition } from "./types"

/**
 * Which values of a server are secrets, and how they are shown masked.
 *
 * The engine hands environment variables and headers back in clear text —
 * they are in clear text in the agents' files — so hiding them is the page's
 * job, everywhere a value appears: the detail, the agent view, the editor,
 * the pasted servers.
 *
 * A value is secret by its NAME: a variable or header whose name contains
 * KEY, TOKEN, SECRET, PASSWORD (or PASSWD), CREDENTIAL, AUTH or COOKIE, in any
 * case — which takes in `Authorization` and `Proxy-Authorization`. Also by its
 * look, for the tokens whose prefix gives them away (`ghp_`, `sk-`, `xoxb-`,
 * …), wherever they sit. In a command's arguments: the value of a
 * `--token=…` argument, the argument after a `--token` flag, and the rest of
 * an `Authorization: …` or `Bearer …` argument. In an address: a password
 * before the host, and the value of a query parameter with a secret name.
 *
 * Masking more than strictly needed costs a click to reveal; masking less
 * leaves a key on someone's screen share.
 */

const SECRET_NAME = /key|token|secret|passw(or)?d|credential|auth|cookie/i

/** Tokens recognisable by their prefix, whatever they are called. */
const TOKEN_VALUE =
  /^(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[abprs]-|AKIA[0-9A-Z]{12,})/

/** What a masked value is shown as: the same length for every value, so the
 *  mask says nothing about the secret. */
export const MASK = "••••••••"

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name)
}

export function looksLikeToken(value: string): boolean {
  return TOKEN_VALUE.test(value.trim())
}

/** Whether a named value (an environment variable, a header) is shown
 *  masked. */
export function isSecretEntry(name: string, value: string): boolean {
  return isSecretName(name) || looksLikeToken(value)
}

// ─── Arguments ────────────────────────────────────────────────────────

/** `--api-key`, `-token`: a flag whose own name is secret-like. */
const SECRET_FLAG = /^--?[\w.-]+$/

/** `--api-key=…`, `TOKEN=…`, `Authorization: …`. */
const NAMED_ARG = /^(--?)?([\w.-]+)(=|:\s*)(.*)$/s

/** The part of `arg` that is secret, as `[start, end)`; `null` for none. */
export function secretArgSpan(
  args: readonly string[],
  index: number
): [number, number] | null {
  const arg = args[index]
  if (arg === undefined || arg === "") return null
  const previous = index > 0 ? args[index - 1] : undefined
  if (
    previous !== undefined &&
    SECRET_FLAG.test(previous) &&
    isSecretName(previous.replace(/^--?/, ""))
  ) {
    return [0, arg.length]
  }
  const named = NAMED_ARG.exec(arg)
  if (named && isSecretName(named[2]) && named[4] !== "") {
    return [arg.length - named[4].length, arg.length]
  }
  const bearer = /^(bearer|basic|token)\s+/i.exec(arg)
  if (bearer && arg.length > bearer[0].length) {
    return [bearer[0].length, arg.length]
  }
  if (looksLikeToken(arg)) return [0, arg.length]
  return null
}

export function isSecretArg(args: readonly string[], index: number): boolean {
  return secretArgSpan(args, index) !== null
}

export function maskArg(args: readonly string[], index: number): string {
  const arg = args[index] ?? ""
  const span = secretArgSpan(args, index)
  return span ? arg.slice(0, span[0]) + MASK : arg
}

// ─── Addresses ────────────────────────────────────────────────────────

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export function urlHasSecret(url: string): boolean {
  const parsed = parseUrl(url)
  if (!parsed) return looksLikeToken(url)
  if (parsed.password !== "") return true
  for (const [name, value] of parsed.searchParams) {
    if (value !== "" && isSecretEntry(name, value)) return true
  }
  return false
}

/**
 * `url` with its secrets masked, otherwise as written — rebuilt by hand
 * rather than through `URL`, which would re-encode what it did not touch.
 */
export function maskUrl(url: string): string {
  const parsed = parseUrl(url)
  if (!parsed) return looksLikeToken(url) ? MASK : url
  let out = url
  if (parsed.password !== "") {
    // `scheme://user:password@host`: everything between the first colon
    // after the scheme's slashes and the `@` that ends the user part.
    out = out.replace(/^([a-z][\w+.-]*:\/\/[^:/@]*:)[^@/]*@/i, `$1${MASK}@`)
  }
  const query = out.indexOf("?")
  if (query === -1) return out
  const hash = out.indexOf("#", query)
  const end = hash === -1 ? out.length : hash
  const pairs = out
    .slice(query + 1, end)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=")
      if (eq === -1) return pair
      const name = safeDecode(pair.slice(0, eq))
      const value = safeDecode(pair.slice(eq + 1))
      return value !== "" && isSecretEntry(name, value)
        ? `${pair.slice(0, eq)}=${MASK}`
        : pair
    })
  return `${out.slice(0, query + 1)}${pairs.join("&")}${out.slice(end)}`
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "))
  } catch {
    return text
  }
}

// ─── Whole definitions ────────────────────────────────────────────────

/** The names of a definition's secret values, for saying which ones will be
 *  written in clear text. Arguments and an address count under their own
 *  description, not a name. */
export interface McpDefinitionSecrets {
  names: string[]
  args: boolean
  url: boolean
}

export function definitionSecrets(
  definition: McpDefinition
): McpDefinitionSecrets {
  if (definition.type === "stdio") {
    const args = definition.args ?? []
    return {
      names: Object.entries(definition.env ?? {})
        .filter(([name, value]) => isSecretEntry(name, value))
        .map(([name]) => name),
      args: args.some((_, index) => isSecretArg(args, index)),
      url: false,
    }
  }
  return {
    names: Object.entries(definition.headers ?? {})
      .filter(([name, value]) => isSecretEntry(name, value))
      .map(([name]) => name),
    args: false,
    url: urlHasSecret(definition.url),
  }
}

export function hasSecrets(definition: McpDefinition): boolean {
  const secrets = definitionSecrets(definition)
  return secrets.names.length > 0 || secrets.args || secrets.url
}

function maskRecord(
  record: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!record) return record
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => [
      name,
      isSecretEntry(name, value) ? MASK : value,
    ])
  )
}

/** The same definition with every secret value replaced by {@link MASK}: what
 *  a view that is not editing shows. */
export function maskDefinition(definition: McpDefinition): McpDefinition {
  if (definition.type === "stdio") {
    const args = definition.args
    return {
      ...definition,
      ...(args ? { args: args.map((_, index) => maskArg(args, index)) } : {}),
      ...(definition.env ? { env: maskRecord(definition.env) } : {}),
    }
  }
  return {
    ...definition,
    url: maskUrl(definition.url),
    ...(definition.headers ? { headers: maskRecord(definition.headers) } : {}),
  }
}
