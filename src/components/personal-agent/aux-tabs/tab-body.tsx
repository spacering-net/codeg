"use client"

/** What every tab's body is drawn with: its scroll, its first paint, its
 *  empty state. */

import { type ReactNode } from "react"
import { type LucideIcon } from "lucide-react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"

/** A tab's body when it has nothing to show: shadcn's empty state on a
 *  soft tile — its icon, what that means and, when there is something to
 *  say, what would fill it. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: LucideIcon
  title: string
  hint?: string
  children?: ReactNode
}) {
  return (
    <Empty className="flex-none gap-3 rounded-xl border border-dashed border-border px-6 py-10">
      <EmptyHeader className="gap-1.5">
        {children ?? (
          <EmptyMedia variant="icon" className="mb-1 bg-muted">
            <Icon className="size-5 text-muted-foreground" aria-hidden />
          </EmptyMedia>
        )}
        <EmptyTitle className="text-sm font-medium tracking-normal">
          {title}
        </EmptyTitle>
        {hint ? (
          <EmptyDescription className="text-xs/relaxed">
            {hint}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
    </Empty>
  )
}

/** First paint: two ghost group cards — a bar over their rows — as far
 *  apart as the real ones. */
export function WorkSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {[2, 1].map((rows, section) => (
        <Skeleton
          key={section}
          className="w-full rounded-2xl"
          style={{ height: `${2.25 + rows * 3.75}rem` }}
        />
      ))}
    </div>
  )
}

/** A tab's body, scrolled: its parts one under another. */
export function TabBody({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <div className="flex min-w-0 flex-col gap-4 px-4 pt-1 pb-6">
        {children}
      </div>
    </ScrollArea>
  )
}
