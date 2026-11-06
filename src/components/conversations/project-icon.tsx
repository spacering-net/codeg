import { cn } from "@/lib/utils"

// Muted colours with balanced brightness and readable white initials.
// Interleaved hues keep neighbouring project IDs visually distinct.
const PROJECT_COLORS = [
  "#5174ad",
  "#3c8066",
  "#915eb3",
  "#b0586e",
  "#906d44",
  "#3d8241",
  "#6b6cb9",
  "#417c8a",
  "#a8614f",
  "#ad529e",
  "#3c7e78",
  "#7d753b",
  "#487999",
  "#3d8156",
  "#8065b7",
  "#af5682",
  "#986948",
  "#527f3c",
  "#5f70b4",
  "#3e7d83",
  "#b15a5a",
  "#a256af",
  "#3c7f6e",
  "#86723f",
]

export function ProjectIcon({
  projectId,
  name,
  className,
}: {
  projectId: number
  name: string
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-project-icon={projectId}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-medium text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/14%)]",
        className
      )}
      style={{
        backgroundColor:
          PROJECT_COLORS[Math.abs(projectId) % PROJECT_COLORS.length],
      }}
    >
      {Array.from(name.trim())[0]?.toUpperCase() || "?"}
    </span>
  )
}
