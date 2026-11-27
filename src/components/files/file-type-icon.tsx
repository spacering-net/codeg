"use client"

import { addCollection, Icon } from "@iconify/react"
import type { IconifyJSON } from "@iconify/react"
import materialIconTheme from "@iconify-json/material-icon-theme/icons.json"
import { FileIcon } from "lucide-react"

import { getFileIconName } from "@/lib/file-icon"

// Register the full Material Icon Theme collection once for offline rendering.
addCollection(materialIconTheme as IconifyJSON)

export type FileTypeIconProps = {
  filename: string
  className?: string
}

export function FileTypeIcon({ filename, className }: FileTypeIconProps) {
  const name = getFileIconName(filename)
  if (!name) {
    return <FileIcon className={className} />
  }
  return <Icon icon={name} className={className} />
}
