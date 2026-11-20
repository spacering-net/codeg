"use client"

import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { BrowserLink } from "@/components/ui/browser-link"
import { cn } from "@/lib/utils"

/**
 * A skill's links open in the system browser — a plain anchor would move the
 * desktop webview itself — and only when they are web addresses: anything
 * else (a relative path into the skill's folder, a `file:` URL) is shown as
 * the text it is.
 */
const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href && /^https?:\/\//i.test(href) ? (
      <BrowserLink
        href={href}
        className="text-primary underline-offset-2 hover:underline"
      >
        {children}
      </BrowserLink>
    ) : (
      <span>{children}</span>
    ),
  // A skill's own images are files in its folder, which the page cannot load;
  // their text stands in.
  img: ({ alt }) => (alt ? <span>[{alt}]</span> : null),
}

/** The body of a SKILL.md, rendered. Loaded with the preview that uses it. */
export function SkillMarkdownBody({ markdown }: { markdown: string }) {
  return (
    <div
      // A skill is written in whatever language its author wrote it in, not
      // the interface's: each paragraph finds its own direction.
      dir="auto"
      className={cn(
        "min-w-0 text-sm leading-6 break-words",
        "[&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-semibold",
        "[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold",
        "[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-semibold",
        "[&_p]:mb-3 [&_li]:mb-1",
        "[&_ul]:list-disc [&_ul]:ps-5 [&_ol]:list-decimal [&_ol]:ps-5",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs",
        "[&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_table]:mb-3 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1",
        "[&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground"
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
