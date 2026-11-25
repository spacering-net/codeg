"use client"

/** A task's branch as a chip: its name in the code face on a soft tile, a
 *  branch icon before it — the side panel's cards say where a task's work
 *  is with it. Left to right in any language. */

import { GitBranch } from "lucide-react"

import { cn } from "@/lib/utils"

export function BranchChip({
  branch,
  className,
}: {
  branch: string
  className?: string
}) {
  return (
    <span
      data-pa-task-branch
      title={branch}
      className={cn(
        "inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md bg-muted px-1.5 font-mono text-xs text-muted-foreground",
        className
      )}
    >
      <GitBranch className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate" dir="ltr">
        {branch}
      </span>
    </span>
  )
}
