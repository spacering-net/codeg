"use client"

import type { ReactNode } from "react"

import { FilePathLink } from "@/components/ai-elements/link-safety"
import { splitPathForDisplay } from "@/lib/activity/format"

/**
 * The header of a detail panel about one file (`DetailBox`'s `header`): the
 * file's name, which opens it in the file tabs (at `line` when there is one),
 * with its folder muted and cut first, and on the end side whatever goes with
 * it — an edit's counts and view switch.
 */
export function FileHeader({
  path,
  displayPath,
  line,
  children,
}: {
  /** The path to open. */
  path: string
  /** The path as the row shows it (relative to the open folder). */
  displayPath?: string
  line?: number | null
  children?: ReactNode
}) {
  const { dir, name } = splitPathForDisplay(displayPath ?? path)
  return (
    <>
      <FilePathLink
        filePath={path}
        line={line}
        title={path}
        className="min-w-0 font-mono text-foreground"
      >
        <span className="flex min-w-0 items-baseline" dir="ltr">
          {dir ? (
            <span className="min-w-0 truncate text-muted-foreground">
              {dir}
            </span>
          ) : null}
          <span className="shrink-0">{name}</span>
        </span>
      </FilePathLink>
      {children ? (
        <span className="ms-auto flex shrink-0 items-center gap-3">
          {children}
        </span>
      ) : null}
    </>
  )
}
