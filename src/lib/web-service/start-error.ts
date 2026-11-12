// Localized text for a failed web-service start. The backend reports a bind
// failure as a stable key in `message` (`web_server.*`, Rust `ERR_*` in
// `src-tauri/src/web/mod.rs`); anything else falls through as-is. Shared by
// the Settings page and the status-bar toggle so both say the same thing.

import { useCallback } from "react"
import { useTranslations } from "next-intl"

const START_ERROR_KEYS: Record<string, string> = {
  "web_server.already_running": "errors.alreadyRunning",
  "web_server.invalid_address": "errors.invalidAddress",
  "web_server.port_in_use": "errors.portInUse",
  "web_server.permission_denied": "errors.permissionDenied",
  "web_server.address_unavailable": "errors.addressUnavailable",
  "web_server.bind_failed": "errors.bindFailed",
}

/** The raw backend message of a failed call, or `""`. */
export function webServerErrorCode(e: unknown): string {
  return e && typeof e === "object" && "message" in e
    ? String((e as { message: unknown }).message)
    : ""
}

/**
 * @param t a translator for the `WebServiceSettings` namespace
 * @param port the port the start was attempted on, for `errors.portInUse`
 */
export function webServerStartErrorMessage(
  e: unknown,
  t: (key: string, values?: Record<string, string | number>) => string,
  port: number
): string {
  const raw = webServerErrorCode(e)
  const key = START_ERROR_KEYS[raw]
  if (key) return t(key, { port })
  return raw || t("startFailed")
}

/** {@link webServerStartErrorMessage} bound to the `WebServiceSettings`
 *  messages, for components. */
export function useWebServerStartErrorMessage() {
  const t = useTranslations("WebServiceSettings")
  return useCallback(
    (e: unknown, port: number) =>
      webServerStartErrorMessage(
        e,
        (key, values) => t(key as Parameters<typeof t>[0], values),
        port
      ),
    [t]
  )
}
