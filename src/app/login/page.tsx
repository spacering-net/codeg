"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { isDesktop } from "@/lib/platform"
import {
  codegAuthHeaders,
  probeProxyAuthentication,
  unauthorizedSource,
} from "@/lib/transport/web-auth"

export default function LoginPage() {
  const router = useRouter()
  const t = useTranslations("LoginPage")
  const tConnection = useTranslations("WebConnection")
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    document.title = t("documentTitle")
  }, [t])

  // Signed in through a proxy in front of Codeg (CODEG_AUTH=proxy-jwt), there
  // is no token to ask for.
  useEffect(() => {
    if (isDesktop()) return
    let cancelled = false
    void probeProxyAuthentication().then((result) => {
      if (!cancelled && result === "proxy") router.replace("/workspace")
    })
    return () => {
      cancelled = true
    }
  }, [router])

  // Desktop users skip login entirely
  if (isDesktop()) {
    router.replace("/workspace")
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)

    try {
      // Validate token by calling a lightweight API endpoint
      const res = await fetch("/api/health", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...codegAuthHeaders(token),
        },
        body: "{}",
      })

      if (res.ok) {
        localStorage.setItem("codeg_token", token)
        router.replace("/workspace")
      } else if (
        res.status === 401 &&
        unauthorizedSource(res.headers.get("www-authenticate")) === "proxy"
      ) {
        // The proxy in front of Codeg refused before the token was checked.
        setError(tConnection("proxySignInDescription"))
      } else if (res.status === 401) {
        setError(t("invalidToken"))
      } else {
        setError(t("connectionFailed", { status: res.status }))
      }
    } catch {
      setError(t("networkError"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">{t("brand")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("tokenPlaceholder")}
              autoFocus
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={!token || loading}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            {loading ? t("connecting") : t("connect")}
          </button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          {t("helpText")}
        </p>
      </div>
    </div>
  )
}
