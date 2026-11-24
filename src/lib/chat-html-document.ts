import {
  inlineHtmlResources,
  withHtmlPreviewHead,
  withSandboxCsp,
} from "./html-preview-inline"
import { htmlPreviewSizeReporter } from "./html-preview-frame"

/** 复用文件预览的惰性解析与 CSP；模型脚本被移除，只有带随机 nonce 的高度桥接可执行。 */
export async function buildChatHtmlDocument(
  source: string,
  { nonce, dark, theme }: { nonce: string; dark: boolean; theme: string }
): Promise<string> {
  const html = await inlineHtmlResources(source, {
    fileDir: "",
    folderPath: "",
    maxInlineBytes: 0,
    stripActiveContent: true,
    readFileBase64: async () => {
      throw new Error("聊天 HTML 不读取本地资源")
    },
  })
  const themed = withHtmlPreviewHead(
    html,
    `<style>
:root{color-scheme:${dark ? "dark" : "light"}}
html,body{margin:0;background:transparent;color:var(--foreground,${dark ? "#fafafa" : "#1a1c1f"});font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
*,*::before,*::after{box-sizing:border-box}
${theme}
</style>`
  )
  const withCsp = withSandboxCsp(themed, { reporterNonce: nonce })
  const end = withCsp.lastIndexOf("</body>")
  return (
    withCsp.slice(0, end) + htmlPreviewSizeReporter(nonce) + withCsp.slice(end)
  )
}
