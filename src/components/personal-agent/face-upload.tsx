"use client"

/**
 * The face editor's upload page: a picture dropped, pasted or picked, then
 * framed in a round window — dragged into place, zoomed with the slider
 * (or the wheel, or − and +), arrows moving it too — and [Set as avatar]
 * crops what the window shows (`cropToAvatarDataUrl`). [Start over] goes
 * back to the drop zone.
 *
 * The desktop's webview takes a file dropped from the OS for its own and
 * never hands the page a drop: there the window's drop event says where it
 * fell and which paths, and a picture dropped on the editor is read from
 * its path.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import { useTranslations } from "next-intl"
import { Minus, Plus } from "lucide-react"

import {
  DRAG_DROP_IMAGE_MAX_BYTES,
  fileNameFromPath,
  mimeTypeFromPath,
  pointWithinElement,
} from "@/components/chat/composer/attachment-files"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import {
  AvatarImageError,
  cropToAvatarDataUrl,
  loadAvatarImage,
} from "@/lib/assistant-avatar"
import { readFileBase64 as readLocalFileBase64 } from "@/lib/tauri"
import { disposeTauriListener } from "@/lib/tauri-listener"
import { isDesktop } from "@/lib/platform"
import { cn } from "@/lib/utils"

import {
  centered,
  clampFraming,
  cropOf,
  scaleAt,
  zoomTo,
  ZOOM_MAX,
  ZOOM_MIN,
  type Framing,
} from "./face-crop"

/** A step of − and +, and of the wheel's notch. */
const ZOOM_STEP = 0.25
/** An arrow key's move, as a share of the window. */
const NUDGE = 0.04

export interface Picture {
  /** Shown in the window (an object URL, let go when it is done with). */
  url: string
  img: HTMLImageElement
  name: string
  width: number
  height: number
}

/** The picture being framed, and how it is taken in. */
export function usePicture() {
  const [picture, setPicture] = useState<Picture | null>(null)
  const [framing, setFraming] = useState<Framing | null>(null)
  const [error, setError] = useState<"unreadable" | "too_large" | null>(null)
  const seq = useRef(0)
  const shown = useRef<string | null>(null)
  const alive = useRef(true)
  const letGo = () => {
    if (shown.current) URL.revokeObjectURL(shown.current)
    shown.current = null
  }
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      letGo()
    }
  }, [])

  /** A picture taken in — or one still being read (the desktop's drop,
   *  from its path): its turn is when it is handed over, so one read
   *  slowly never replaces one taken after it, nor comes back after
   *  [Start over]. */
  const take = useCallback(
    async (source: Blob | Promise<Blob>, name: string) => {
      const mine = ++seq.current
      setError(null)
      try {
        const file = await source
        if (seq.current !== mine || !alive.current) return
        const img = await loadAvatarImage(file)
        if (seq.current !== mine || !alive.current) return
        letGo()
        const url = URL.createObjectURL(file)
        shown.current = url
        const width = img.naturalWidth
        const height = img.naturalHeight
        setPicture({ url, img, name, width, height })
        setFraming(centered(1, width, height))
      } catch (e) {
        if (seq.current !== mine || !alive.current) return
        setError(
          e instanceof AvatarImageError && e.reason === "too_large"
            ? "too_large"
            : "unreadable"
        )
      }
    },
    []
  )
  const clear = useCallback(() => {
    seq.current += 1
    letGo()
    setPicture(null)
    setFraming(null)
    setError(null)
  }, [])
  return { picture, framing, setFraming, error, setError, take, clear }
}

export type PictureState = ReturnType<typeof usePicture>

/** The first picture among `files`, if any. */
export function firstImage(files: FileList | readonly File[] | null) {
  return Array.from(files ?? []).find((f) => f.type.startsWith("image/"))
}

/** A picture pasted anywhere in the editor. */
export function pastedImage(e: ReactClipboardEvent): File | undefined {
  return firstImage(e.clipboardData?.files ?? null)
}

function base64ToBlob(data: string, type: string): Blob {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

/** The desktop's drops from the OS, on `host`: the first picture's path,
 *  handed to `onFile` at once as it is being read. */
export function useOsImageDrop(
  host: RefObject<HTMLElement | null>,
  onFile: (file: Promise<Blob>, name: string) => void,
  lastDomDrop: RefObject<number>
) {
  const handler = useRef(onFile)
  useEffect(() => {
    handler.current = onFile
  })
  useEffect(() => {
    if (!isDesktop()) return
    let cancelled = false
    let unlisten: (() => void | Promise<void>) | null = null
    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      const { TauriEvent } = await import("@tauri-apps/api/event")
      const off = await getCurrentWebview().listen<{
        paths: string[]
        position: { x: number; y: number }
      }>(TauriEvent.DRAG_DROP, (event) => {
        const el = host.current
        if (cancelled || !el) return
        // Also handed to the page as a drop: taken there.
        if (Date.now() - lastDomDrop.current < 250) return
        if (!pointWithinElement(event.payload.position, el)) return
        const path = event.payload.paths.find((p) =>
          mimeTypeFromPath(p)?.startsWith("image/")
        )
        if (!path) return
        handler.current(
          readLocalFileBase64(path, DRAG_DROP_IMAGE_MAX_BYTES).then((data) =>
            base64ToBlob(data, mimeTypeFromPath(path) ?? "image/png")
          ),
          fileNameFromPath(path)
        )
      })
      if (cancelled) disposeTauriListener(off, "FaceUpload.dragDrop")
      else unlisten = off
    })().catch(() => {})
    return () => {
      cancelled = true
      if (unlisten) disposeTauriListener(unlisten, "FaceUpload.dragDrop")
    }
  }, [host, lastDomDrop])
}

export function FaceUpload({
  state,
  onSet,
  disabled,
  onDomDrop,
}: {
  state: PictureState
  /** The cropped picture, as a data URL. */
  onSet: (dataUrl: string) => void
  disabled?: boolean
  /** A drop the page was handed (the desktop's for it is then not taken). */
  onDomDrop: () => void
}) {
  const t = useTranslations("PersonalAgent.bots.face")
  const { picture, framing, error } = state
  const errorText = error
    ? t(error === "too_large" ? "tooLarge" : "unreadable")
    : null
  return picture && framing ? (
    <Framer
      picture={picture}
      framing={framing}
      onFraming={state.setFraming}
      onRestart={state.clear}
      onSet={() => {
        try {
          onSet(
            cropToAvatarDataUrl(
              picture.img,
              cropOf(1, picture.width, picture.height, framing)
            )
          )
        } catch (e) {
          state.setError(
            e instanceof AvatarImageError && e.reason === "too_large"
              ? "too_large"
              : "unreadable"
          )
        }
      }}
      disabled={disabled}
      error={errorText}
    />
  ) : (
    <DropZone
      onFile={(file) => void state.take(file, file.name)}
      disabled={disabled}
      error={errorText}
      onDomDrop={onDomDrop}
    />
  )
}

function DropZone({
  onFile,
  disabled,
  error,
  onDomDrop,
}: {
  onFile: (file: File) => void
  disabled?: boolean
  error: string | null
  onDomDrop: () => void
}) {
  const t = useTranslations("PersonalAgent.bots.face")
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [over, setOver] = useState(false)
  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault()
    setOver(false)
    onDomDrop()
    const file = firstImage(e.dataTransfer?.files ?? null)
    if (file && !disabled) onFile(file)
  }
  return (
    <div
      data-pa-face-drop
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        "flex h-56 flex-col items-center justify-center gap-2 rounded-2xl border-[1.5px] border-dashed border-border px-4 text-center transition-colors",
        over && "border-ring bg-muted/50"
      )}
    >
      <p className="text-sm text-muted-foreground">{t("dropHint")}</p>
      <p className="text-xs text-muted-foreground/80">{t("or")}</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="rounded-full px-4"
        disabled={disabled}
        onClick={() => fileRef.current?.click()}
        data-pa-face-pick-file
      >
        {t("pickFile")}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-pa-face-file
        onChange={(e) => {
          const file = firstImage(e.target.files)
          if (file) onFile(file)
          e.target.value = ""
        }}
      />
    </div>
  )
}

function Framer({
  picture,
  framing,
  onFraming,
  onRestart,
  onSet,
  disabled,
  error,
}: {
  picture: Picture
  framing: Framing
  onFraming: (f: Framing) => void
  onRestart: () => void
  onSet: () => void
  disabled?: boolean
  error: string | null
}) {
  const t = useTranslations("PersonalAgent.bots.face")
  const { width, height } = picture
  const windowRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{
    pointer: number
    x: number
    y: number
    from: Framing
  } | null>(null)
  const s = scaleAt(1, width, height, framing.zoom)
  const zoom = (z: number) => onFraming(zoomTo(1, width, height, framing, z))
  const move = (dx: number, dy: number, from: Framing = framing) =>
    onFraming(
      clampFraming(1, width, height, {
        ...from,
        x: from.x + dx,
        y: from.y + dy,
      })
    )

  // The wheel zooms — not passively, so the page round it does not scroll.
  const zoomRef = useRef(zoom)
  useEffect(() => {
    zoomRef.current = zoom
  })
  const framingRef = useRef(framing)
  useEffect(() => {
    framingRef.current = framing
  })
  useEffect(() => {
    const el = windowRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const by = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
      zoomRef.current(framingRef.current.zoom + by)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = {
      pointer: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      from: framing,
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointer !== e.pointerId) return
    const side = e.currentTarget.getBoundingClientRect().width || 1
    move((e.clientX - d.x) / side, (e.clientY - d.y) / side, d.from)
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null
  }
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const by: Record<string, [number, number]> = {
      ArrowLeft: [NUDGE, 0],
      ArrowRight: [-NUDGE, 0],
      ArrowUp: [0, NUDGE],
      ArrowDown: [0, -NUDGE],
    }
    const d = by[e.key]
    if (d) {
      e.preventDefault()
      move(d[0], d[1])
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault()
      zoom(framing.zoom + ZOOM_STEP)
    } else if (e.key === "-") {
      e.preventDefault()
      zoom(framing.zoom - ZOOM_STEP)
    }
  }

  const pct = (v: number) => `${v * 100}%`
  return (
    <div className="flex flex-col items-center" data-pa-face-framer>
      <div
        ref={windowRef}
        role="img"
        tabIndex={0}
        aria-label={t("dragHint")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
        className="relative size-44 cursor-grab touch-none overflow-hidden rounded-full bg-muted outline-none select-none active:cursor-grabbing focus-visible:ring-3 focus-visible:ring-ring/40"
        data-pa-face-window
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- an object URL of a local picture */}
        <img
          src={picture.url}
          alt=""
          draggable={false}
          className="pointer-events-none absolute max-w-none"
          style={{
            left: pct(framing.x),
            top: pct(framing.y),
            width: pct(width * s),
            height: pct(height * s),
          }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-black/5 ring-inset dark:ring-white/10"
        />
      </div>
      <p
        className="mt-3 max-w-full truncate text-sm text-muted-foreground"
        title={picture.name}
        data-pa-face-file-info
      >
        {picture.name ? `${picture.name} · ` : ""}
        {width}×{height}
      </p>
      <p className="text-xs text-muted-foreground/80">{t("dragHint")}</p>
      <div className="mt-3 flex w-full items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("zoomOut")}
          title={t("zoomOut")}
          disabled={framing.zoom <= ZOOM_MIN}
          onClick={() => zoom(framing.zoom - ZOOM_STEP)}
          data-pa-face-zoom-out
        >
          <Minus aria-hidden />
        </Button>
        <Slider
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={0.01}
          value={[framing.zoom]}
          onValueChange={([z]) => zoom(z)}
          aria-label={t("zoom")}
          className="flex-1"
          data-pa-face-zoom
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("zoomIn")}
          title={t("zoomIn")}
          disabled={framing.zoom >= ZOOM_MAX}
          onClick={() => zoom(framing.zoom + ZOOM_STEP)}
          data-pa-face-zoom-in
        >
          <Plus aria-hidden />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-3 grid w-full grid-cols-2 gap-2">
        <Button
          type="button"
          variant="secondary"
          className="rounded-full"
          onClick={onRestart}
          data-pa-face-restart
        >
          {t("restart")}
        </Button>
        <Button
          type="button"
          className="rounded-full"
          disabled={disabled}
          onClick={onSet}
          data-pa-face-set
        >
          {t("setAvatar")}
        </Button>
      </div>
    </div>
  )
}
