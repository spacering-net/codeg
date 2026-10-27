import type { AuthMethod } from '@agentclientprotocol/sdk'

export const PI_SETUP_METHOD_ID = 'pi_terminal_login'

/**
 * Zed (and some other clients) currently support "Terminal Auth" via an extension field
 * in AuthMethod._meta, rather than the RFD "type/args/env" shape.
 *
 * We include BOTH for maximum compatibility:
 *  - `_meta["terminal-auth"]`: used by Zed to render the "Authenticate" banner + button.
 *  - `type/args/env`: registry-required shape.
 */
export function getAuthMethods(opts?: { supportsTerminalAuthMeta?: boolean }): AuthMethod[] {
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? true

  const method: any = {
    id: PI_SETUP_METHOD_ID,
    name: 'Launch pi in the terminal',
    description: 'Start pi in an interactive terminal to configure API keys or login',

    // Registry-required fields
    type: 'terminal',
    args: ['--terminal-login'],
    env: {}
  }

  if (supportsTerminalAuthMeta) {
    // Best-effort launch spec for Zed's terminal-auth banner.
    // Zed expects a full command+args (see mistral-vibe implementation).
    const launch = terminalAuthLaunchSpec()

    method._meta = {
      ...(method._meta ?? {}),
      'terminal-auth': {
        ...launch,
        label: 'Launch pi'
      }
    }
  }

  return [method as AuthMethod]
}

function terminalAuthLaunchSpec(): { command: string; args: string[] } {
  // If we were launched as `node /path/to/dist/index.js`, reuse that.
  // This is the most reliable in local dev and custom Zed configurations.
  const argv0 = process.argv[0] || 'node'
  const argv1 = process.argv[1]
  if (argv1 && argv0) {
    const isNode = argv0.includes('node')
    const isJs = argv1.endsWith('.js')
    if (isNode && isJs) {
      return { command: argv0, args: [argv1, '--terminal-login'] }
    }
  }

  // Fallback: assume `pi-acp` is on PATH.
  return { command: 'pi-acp', args: ['--terminal-login'] }
}
