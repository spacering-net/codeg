"use client"

import { useMemo, useState, useCallback, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import { ShadcnConfigPanel } from "./shadcn-config-panel"
import { ShadcnPreview } from "./shadcn-preview"
import {
  DEFAULT_PRESET_CONFIG,
  encodePreset,
  buildPreviewUrl,
  type ShadcnPresetConfig,
} from "./constants"

const MIN_WIDTH = 260
const MAX_WIDTH = 420
const DEFAULT_WIDTH = 320

export function ShadcnLauncher() {
  const [config, setConfig] = useState<ShadcnPresetConfig>(
    DEFAULT_PRESET_CONFIG
  )
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH)
  const [isDragging, setIsDragging] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const presetCode = useMemo(() => encodePreset(config), [config])
  const previewUrl = useMemo(
    () => buildPreviewUrl(config.base, presetCode),
    [config.base, presetCode]
  )

  const updateConfig = (key: keyof ShadcnPresetConfig, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsDragging(true)
      startXRef.current = e.clientX
      startWidthRef.current = sidebarWidth
    },
    [sidebarWidth]
  )

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.min(
        MAX_WIDTH,
        Math.max(
          MIN_WIDTH,
          startWidthRef.current + (e.clientX - startXRef.current)
        )
      )
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)

    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
    }
  }, [isDragging])

  return (
    <div className="flex h-full">
      <div style={{ width: sidebarWidth }} className="shrink-0">
        <ShadcnConfigPanel
          config={config}
          onConfigChange={updateConfig}
          presetCode={presetCode}
        />
      </div>

      <div
        className={cn(
          "relative z-20 flex w-px cursor-col-resize items-center justify-center",
          "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:h-full before:w-[var(--resize-handle-thickness)] before:-translate-x-1/2 before:bg-border before:transition-[width,background-color] before:duration-150 before:ease-out",
          "after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2",
          // Opaque thickened line, for the same reason as `ResizableHandle`:
          // the 5px line is centred on a 1px handle box that neither column
          // backs, so a translucent one shows a seam down its middle wherever
          // the columns' background differs from the page's.
          isDragging
            ? "[--resize-handle-thickness:5px] before:bg-[var(--resize-handle-drag)]"
            : "[--resize-handle-thickness:1px] hover:[--resize-handle-thickness:5px] hover:before:bg-[var(--resize-handle-hover)]"
        )}
        onMouseDown={handleMouseDown}
      />

      <div
        className={cn("min-w-0 flex-1", isDragging && "pointer-events-none")}
      >
        <ShadcnPreview previewUrl={previewUrl} />
      </div>
    </div>
  )
}
