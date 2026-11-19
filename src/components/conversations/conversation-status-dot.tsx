"use client"

import type { ReactNode } from "react"
import type { ConversationStatus } from "@/lib/types"
import { STATUS_COLORS } from "@/lib/types"
import { cn } from "@/lib/utils"

type ConversationStatusDotSize = "xs" | "sm" | "md"

interface ConversationStatusDotProps {
  status?: ConversationStatus | null
  waiting?: boolean
  size?: ConversationStatusDotSize
  className?: string
  title?: string
  children?: ReactNode
}

const SIZE_CLASS: Record<ConversationStatusDotSize, string> = {
  xs: "h-1 w-1",
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
}

const FALLBACK_COLOR = "bg-gray-400 dark:bg-gray-500"

export function ConversationStatusDot({
  status,
  waiting = false,
  size = "md",
  className,
  title,
  children,
}: ConversationStatusDotProps) {
  const colorClass = waiting
    ? "bg-orange-500"
    : (status && STATUS_COLORS[status]) || FALLBACK_COLOR
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        SIZE_CLASS[size],
        colorClass,
        className
      )}
      title={title}
      aria-hidden={title ? undefined : true}
    >
      {children}
    </span>
  )
}
