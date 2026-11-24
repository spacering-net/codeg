"use client"

import type { ReactNode } from "react"

import { BrowserLink } from "@/components/ui/browser-link"
import { httpsUrl } from "@/lib/harness/display"
import { cn } from "@/lib/utils"

interface HarnessLinkProps {
  /** An address from the catalog: a repository, a website, a link inside a
   *  description. Third-party text, so it is checked before it is a link. */
  href: unknown
  children: ReactNode
  className?: string
}

/**
 * A link whose address came from the catalog.
 *
 * It is a link only when the address is `https:` (see `httpsUrl`); anything
 * else — `http:`, `mailto:`, a script scheme, a relative path, nothing at all
 * — is shown as the plain text it wraps. A link always opens in the system
 * browser (`BrowserLink`), never inside the app.
 *
 * The address is also the tooltip: the words of a link are the author's, and
 * where it actually leads should be one hover away.
 */
export function HarnessLink({ href, children, className }: HarnessLinkProps) {
  const safe = httpsUrl(href)
  if (!safe) return <>{children}</>
  return (
    <BrowserLink
      href={safe}
      title={safe}
      className={cn(
        "rounded-sm text-primary underline decoration-primary/40 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      {children}
    </BrowserLink>
  )
}
