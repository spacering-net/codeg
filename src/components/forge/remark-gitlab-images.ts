import type { Definition, Image, ImageReference, Root } from "mdast"
import { visit } from "unist-util-visit"

const UPLOAD_PATH = /^\/uploads\/[a-f\d]{32}\/[^/?#]+$/i

/** GitLab's `/uploads/…` is relative to the project, including on instances
 * mounted under a URL prefix. Absolute URLs must name this same project. */
export function gitlabUploadPath(
  source: string,
  projectUrl: string
): string | null {
  const relative = source.startsWith("uploads/") ? `/${source}` : source
  if (UPLOAD_PATH.test(relative)) return relative
  try {
    const project = new URL(`${projectUrl.replace(/\/+$/, "")}/`)
    const url = new URL(source, project)
    if (
      url.origin !== project.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(project.pathname)
    ) {
      return null
    }
    const path = `/${url.pathname.slice(project.pathname.length)}`
    return UPLOAD_PATH.test(path) ? path : null
  } catch {
    return null
  }
}

/** Only consume GitLab image dimensions immediately following an image node.
 * Code examples, escaped braces and ordinary text retain their source. */
export function remarkGitlabImages({ projectUrl }: { projectUrl: string }) {
  return (tree: Root, file: unknown) => {
    const document = String(file)
    const definitions = new Map<string, Definition>()
    visit(tree, "definition", (node) => {
      const key = node.identifier.toUpperCase()
      if (!definitions.has(key)) definitions.set(key, node)
    })
    visit(tree, ["image", "imageReference"], (node, index, parent) => {
      const image = node as Image | ImageReference
      const origin =
        image.type === "image"
          ? image
          : definitions.get(image.identifier.toUpperCase())
      if (!origin?.url) return

      const dimensions: { width?: number; height?: number } = {}
      const next = index == null ? undefined : parent?.children[index + 1]
      const end = image.position?.end.offset
      if (next?.type === "text" && end != null) {
        const match =
          /^\{((?:width|height)=[1-9]\d*(?:\s+(?:width|height)=[1-9]\d*)?)\}/.exec(
            document.slice(end)
          )
        if (match && next.value.startsWith(match[0])) {
          const attributes = match[1]
            .split(/\s+/)
            .map((part) => part.split("="))
          if (
            new Set(attributes.map(([key]) => key)).size ===
              attributes.length &&
            attributes.every(([, value]) => Number.isSafeInteger(Number(value)))
          ) {
            for (const [key, value] of attributes) {
              dimensions[key as "width" | "height"] = Number(value)
            }
            next.value = next.value.slice(match[0].length)
          }
        }
      }

      const upload = gitlabUploadPath(origin.url, projectUrl)
      if (upload) {
        // Run after remarkLocalImages so project uploads replace its local
        // file marker. Keep the URL inert through sanitize/harden; React asks
        // the backend for authenticated bytes, never for a local file.
        image.data = {
          hName: "span",
          hProperties: {
            "data-codeg-forge-image": upload,
            "data-codeg-image-width": dimensions.width,
            "data-codeg-image-height": dimensions.height,
          },
          hChildren: [{ type: "text", value: image.alt ?? "" }],
        }
      } else if (Object.keys(dimensions).length) {
        image.data = {
          ...image.data,
          hProperties: { ...image.data?.hProperties, ...dimensions },
        }
      }
    })
  }
}
