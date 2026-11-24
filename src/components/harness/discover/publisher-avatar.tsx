"use client"

import { useSrnAsset } from "@/lib/harness/use-srn-asset"
import { cn } from "@/lib/utils"

interface PublisherAvatarProps {
  /** The publisher's handle: what the fallback takes its letter from. */
  handle: string
  /** The site-relative address of its picture, or `null` for none. */
  avatar: string | null | undefined
  className?: string
}

/**
 * A publisher's picture, or — while it loads, when it fails, when there is
 * none — the first letter of the handle. Decorative either way: the name is
 * always written next to it.
 *
 * The box has its size from the start, so a picture arriving late never moves
 * the card around it. The bytes come through the backend (`useSrnAsset`).
 */
export function PublisherAvatar({
  handle,
  avatar,
  className,
}: PublisherAvatarProps) {
  const { src } = useSrnAsset(avatar)
  const letter = (
    [...handle].find((char) => /[\p{L}\p{N}]/u.test(char)) ?? "?"
  ).toUpperCase()

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-3xs font-medium text-muted-foreground ring-1 ring-border/60 select-none",
        className
      )}
    >
      {src ? (
        // A blob URL minted from proxied bytes: nothing for next/image to
        // optimise, and no network address at all.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        letter
      )}
    </span>
  )
}
