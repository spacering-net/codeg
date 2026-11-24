import {
  DEFAULT_WEB_SERVICE_HOST,
  WEB_SERVICE_HOSTS,
  type WebServiceHost,
} from "@/lib/api"

/** A bind host from the backend, narrowed to the choices the desktop offers
 *  (anything else reads as the default, as the backend treats it). */
export function asWebServiceHost(
  host: string | null | undefined
): WebServiceHost {
  return (WEB_SERVICE_HOSTS as readonly string[]).includes(host ?? "")
    ? (host as WebServiceHost)
    : DEFAULT_WEB_SERVICE_HOST
}

/** Whether a bind host keeps the service on this machine. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1"
}
