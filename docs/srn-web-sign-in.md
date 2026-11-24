# SRN sign-in for Codeg Web

Codeg Web can let each browser sign in with an SRN, the
[SpaceRing](https://spacering.net) account. The server runs the whole OAuth
flow on the browser's behalf and keeps the sign-in itself; the browser only
holds two `HttpOnly` cookies.

An SRN sign-in says which SRN user a browser is. It does not grant access to
the server and does not replace the access token (`CODEG_TOKEN`) or
[proxy sign-in](proxy-auth.md): a browser still needs those to use the
workspace, and the workspace stays shared by everyone who has access. Each
browser's SRN identity is its own and does not affect the desktop app's
account.

SRN sign-in is off until all three settings below are in place. A missing or
invalid setting only turns it off, with one line in the server log saying why;
instance access is never affected.

## 1. Register the instance

Every Codeg Web instance needs its own SpaceRing client. Registration is done
by SpaceRing's operators with `scripts/register-codeg-client.mjs` from the
website's repository; ask them with your SRN and the address of your instance:

```sh
node scripts/register-codeg-client.mjs --owner-srn <your SRN> \
  --public-url https://codeg.example.com --output /secure/codeg-registration
```

The address must be:

- **HTTPS**, with a certificate browsers trust;
- an **exclusive host name**: one Codeg instance per host name (`codeg.example.com`),
  not an IP address; sharing a host name across ports or paths is not supported;
- served at the **root path** on the **standard port** (443).

A private host name works as long as the browsers that use it can reach it;
SpaceRing never connects to your instance. Local development needs HTTPS too:
use a locally trusted certificate (for example `mkcert`) on a host name, or a
tunnel that gives you one. SpaceRing does not accept a plain `http://` Web
callback.

You receive a client ID (`codeg-web-…`) and a restricted file `client-secret`
(mode 0600). Keep the file private: out of images, backups, logs, command
lines and anything agents can read.

## 2. Configure Codeg

| Variable | Value |
| --- | --- |
| `CODEG_PUBLIC_URL` | The registered address, e.g. `https://codeg.example.com`. Browsers' `Origin` must equal it, and the sign-in's return address is built from it alone (never from `Host` or `X-Forwarded-*`). |
| `CODEG_SRN_CLIENT_ID` | The client ID, `codeg-web-…`. Never the desktop app's client. |
| `CODEG_SRN_CLIENT_SECRET_FILE` | Path of the `client-secret` file. Codeg reads the secret from it; it never goes into a variable or an argument. |

```bash
CODEG_PUBLIC_URL=https://codeg.example.com
CODEG_SRN_CLIENT_ID=codeg-web-<generated ID>
CODEG_SRN_CLIENT_SECRET_FILE=/run/secrets/codeg-srn-client-secret
```

The settings are read once, at startup. The log says
`[srn-web] SRN sign-in is on for https://codeg.example.com`, or why it is off.
If the secret file can be read by other accounts on the machine, the log says
so; restrict it with `chmod 600`. Codeg removes the three variables from the
environment of the agents, terminals and tools it starts.

The desktop app's built-in web service reads the same three variables from the
desktop app's environment, when the service first starts. It needs a
registration of its own (its own host name), separate from the desktop app's
sign-in, which it does not touch.

## 3. The reverse proxy

SpaceRing sends the browser back to `https://<your host>/auth/srn/callback`
with a one-time code in the query. Codeg answers this one address without the
access token (a browser coming back from another site carries neither the
token nor, under proxy sign-in, a same-site request); it only completes a
sign-in that a signed-in page of the same browser started.

- Pass `/auth/srn/callback` through to Codeg unchanged. A proxy that requires
  its own login there may lose the query; the person then starts the sign-in
  again.
- **Do not log the query of `/auth/srn/callback`** in access logs (log the path
  only). The code is single-use and expires within a minute, but it does not
  belong in logs.

## What the server keeps

| Where | What |
| --- | --- |
| `codeg.db`, tables `srn_web_logins` and `srn_web_sessions` | Sign-ins under way (ten minutes) and signed-in browsers. Cookies and states only as SHA-256; tokens and PKCE verifiers encrypted (AES-256-GCM); the SRN number, display name and avatar path in clear. Included in Codeg's backup. |
| `<data dir>/srn-web.key` (`codeg-server`) | The encryption key, mode 0600, created on first use. **Not** in Codeg's backup. |
| Keychain entry `srn-web-key` (desktop app) | The same key for the built-in web service. Not in the backup. |

A backup restored on another machine has no key for its sessions: those
browsers are signed out and sign in again. A snapshot of the whole data volume
contains both the database and the key; that is within the trust boundary
below.

A session ends after 30 days without use, as SpaceRing's connection does; an
hourly task removes what has expired and ends those connections on SpaceRing.
Sessions survive restarts and upgrades. One server process per data directory
is supported; several replicas would have to share the database and the key.

## Trust boundary

The server keeps each signed-in browser's SRN token (read-only profile access)
on its behalf. Whoever operates the instance, or can run code on it — including
agents — can reach those tokens. SpaceRing's authorization page tells the
person which instance they are connecting. This is not a guarantee of secrecy
from the instance's administrators and not a multi-tenant separation.
