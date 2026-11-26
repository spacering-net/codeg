"use client"

import type { ReactNode } from "react"
import type { ConversationStatus } from "@/lib/types"
import { STATUS_COLORS } from "@/lib/types"
import type { BlockingPromptKind } from "@/lib/blocking-prompts"
import { cn } from "@/lib/utils"

type ConversationStatusDotSize = "xs" | "sm" | "md"

interface ConversationStatusDotProps {
  status?: ConversationStatus | null
  size?: ConversationStatusDotSize
  className?: string
  title?: string
  children?: ReactNode
  /**
   * 连接停在某个决策上，用户不动它就不会继续（见 `conversation-attention`）。
   * 它优先于 `status`：一个等待你回答的会话同时还是 `in_progress`，若照常画成
   * 运行中的琥珀色，恰好抹掉了这个标记存在的意义。
   *
   * 三种等待只用一个静态紫色圆点表示，具体是哪一种由调用方的 `title` 和卡片
   * 上的悬停提示说明，不由 6 像素的圆点区分。圆点不加外圈、不加动画，减少多个
   * 会话同时等待时的视觉干扰，并保留调用方指定的尺寸和定位。
   */
  attention?: BlockingPromptKind | null
}

const SIZE_CLASS: Record<ConversationStatusDotSize, string> = {
  xs: "h-1 w-1",
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
}

const FALLBACK_COLOR = "bg-gray-400 dark:bg-gray-500"

/** 等待你处理的会话统一用紫色，与侧栏等待图标、文件夹等待计数同一个色系。 */
const ATTENTION_COLOR = "bg-violet-500 dark:bg-violet-400"

export function ConversationStatusDot({
  status,
  size = "md",
  className,
  title,
  children,
  attention,
}: ConversationStatusDotProps) {
  const colorClass = attention
    ? ATTENTION_COLOR
    : (status && STATUS_COLORS[status]) || FALLBACK_COLOR
  return (
    <span
      // 种类落在 DOM 上，测试（以及将来可能的 CSS）无需读颜色就能区分三种等待。
      data-attention={attention ?? undefined}
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
