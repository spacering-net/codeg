"use client"

import type { MotionProps } from "motion/react"
import type { CSSProperties, ElementType, JSX } from "react"

import { cn } from "@/lib/utils"
import { motion } from "motion/react"
import { memo, useMemo } from "react"
import { useChatAnimationsEnabled } from "@/hooks/use-appearance"

type MotionHTMLProps = MotionProps & Record<string, unknown>

// Cache motion components at module level to avoid creating during render
const motionComponentCache = new Map<
  keyof JSX.IntrinsicElements,
  React.ComponentType<MotionHTMLProps>
>()

const getMotionComponent = (element: keyof JSX.IntrinsicElements) => {
  let component = motionComponentCache.get(element)
  if (!component) {
    component = motion.create(element)
    motionComponentCache.set(element, component)
  }
  return component
}

export interface TextShimmerProps {
  children: string
  as?: ElementType
  className?: string
  duration?: number
  spread?: number
  shineColor?: string
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
  shineColor,
}: TextShimmerProps) => {
  const animated = useChatAnimationsEnabled()
  const MotionComponent = useMemo(
    () => getMotionComponent(Component as keyof JSX.IntrinsicElements),
    [Component]
  )

  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  )

  const shine = shineColor ?? "var(--color-background)"

  return (
    // eslint-disable-next-line react-hooks/static-components -- component is cached at module level via motionComponentCache
    <MotionComponent
      animate={{ backgroundPosition: animated ? "0% center" : "100% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text bg-no-repeat text-transparent",
        className
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage: `linear-gradient(90deg, #0000 calc(50% - var(--spread)), ${shine}, #0000 calc(50% + var(--spread))), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))`,
        } as CSSProperties
      }
      transition={
        animated
          ? {
              duration,
              ease: "linear",
              repeat: Number.POSITIVE_INFINITY,
            }
          : { duration: 0 }
      }
    >
      {children}
    </MotionComponent>
  )
}

export const Shimmer = memo(ShimmerComponent)
