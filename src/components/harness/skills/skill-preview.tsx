"use client"

import { useMemo } from "react"
import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"

import { Skeleton } from "@/components/ui/skeleton"
import { parseYamlFrontMatter } from "@/lib/skill-frontmatter"

// The Markdown stack comes with the first preview shown, not with the
// workspace: nothing on its first paint needs it.
const SkillMarkdownBody = dynamic(
  async () => (await import("./skill-markdown-body")).SkillMarkdownBody,
  {
    ssr: false,
    loading: () => (
      <div aria-hidden="true" className="space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    ),
  }
)

/**
 * A SKILL.md as it reads: its front matter as fields, its body rendered. The
 * one preview of the Skills and Skill-packs sections — the detail, the
 * editor's preview, a pack skill's content.
 */
export function SkillPreview({ content }: { content: string }) {
  const t = useTranslations("Harness.skills.preview")
  const parsed = useMemo(() => parseYamlFrontMatter(content), [content])
  const body = parsed.body.trim()
  return (
    <div className="min-w-0 space-y-3">
      {parsed.frontMatterRaw !== null && (
        <dl className="grid min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          {parsed.fields.length > 0 ? (
            parsed.fields.map((field) => (
              <div key={field.key} className="contents">
                <dt className="font-mono text-muted-foreground">
                  <bdi dir="ltr">{field.key}</bdi>
                </dt>
                <dd dir="auto" className="min-w-0 [overflow-wrap:anywhere]">
                  {field.value}
                </dd>
              </div>
            ))
          ) : (
            <pre className="col-span-2 font-mono whitespace-pre-wrap text-muted-foreground">
              {parsed.frontMatterRaw}
            </pre>
          )}
        </dl>
      )}
      {body ? (
        <SkillMarkdownBody markdown={parsed.body} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {parsed.frontMatterRaw !== null ? t("onlyMetadata") : t("empty")}
        </p>
      )}
    </div>
  )
}
