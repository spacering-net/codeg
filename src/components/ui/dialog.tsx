"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { OverlayPortalContainerProvider } from "@/components/ui/overlay-portal-container"
import { useNestedLayerDismissGuard } from "@/hooks/use-nested-layer-dismiss-guard"
import { cn } from "@/lib/utils"
import { acquireNativeSurfaceOcclusionFor } from "@/lib/browser/native-surface-occlusion"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/80 duration-100 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-50",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  closeButtonClassName,
  showCloseButton = true,
  ref,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  closeButtonClassName?: string
  showCloseButton?: boolean
}) {
  // Without this, closing a nested Select/DropdownMenu by clicking elsewhere in
  // the dialog closes the dialog too.
  const {
    node,
    setNode,
    onPointerDownOutside: guardOutsidePress,
  } = useNestedLayerDismissGuard<HTMLDivElement>(ref)
  // A native browser surface would paint over this overlay, so it holds an
  // occlusion lease exactly while its DOM exists (this component stays mounted
  // with the dialog closed; only the primitive's content comes and goes).
  const contentRef = React.useCallback(
    (contentNode: HTMLDivElement | null) => {
      const detach = setNode(contentNode)
      const release = acquireNativeSurfaceOcclusionFor("dialog", true)
      return () => {
        release()
        if (typeof detach === "function") detach()
      }
    },
    [setNode]
  )
  return (
    <DialogPortal>
      <DialogOverlay />
      <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
        <DialogPrimitive.Content
          data-slot="dialog-content"
          ref={contentRef}
          onPointerDownOutside={(event) => {
            onPointerDownOutside?.(event)
            guardOutsidePress(event)
          }}
          className={cn(
            "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 bg-background ring-border pointer-events-auto relative grid max-h-[calc(100dvh-2rem)] w-full max-w-md gap-6 overflow-y-auto rounded-4xl p-6 shadow-2xl ring-1 duration-100 outline-none",
            showCloseButton && "[&_[data-slot=dialog-header]]:pr-10",
            className
          )}
          {...props}
        >
          {/* Nested layers portal in here rather than to the body, so the
              scroll lock lets the wheel through to them. */}
          <OverlayPortalContainerProvider container={node}>
            {children}
          </OverlayPortalContainerProvider>
          {showCloseButton && (
            <DialogPrimitive.Close data-slot="dialog-close" asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "absolute top-4 right-4 hover:text-destructive focus-visible:text-destructive",
                  closeButtonClassName
                )}
              >
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("grid gap-1.5", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-medium", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
