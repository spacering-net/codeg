import { memo } from "react"
import { folderBadgeColor, folderBadgeLabel } from "@/lib/folder-badge"
import { cn } from "@/lib/utils"

interface FolderBadgeProps {
  folderId: number
  folderName: string
  /** Size variant: sm ~= tab bar (14px), md ~= sidebar card (16px). */
  size?: "sm" | "md"
  className?: string
}

export const FolderBadge = memo(function FolderBadge({
  folderId,
  folderName,
  size = "sm",
  className,
}: FolderBadgeProps) {
  return (
    <span
      aria-label={folderName}
      title={folderName}
      className={cn(
        "inline-flex items-center justify-center shrink-0 rounded text-white font-medium",
        size === "sm" ? "w-3.5 h-3.5 text-[0.5625rem]" : "w-4 h-4 text-3xs",
        folderBadgeColor(folderId),
        className
      )}
    >
      {folderBadgeLabel(folderName)}
    </span>
  )
})
