import type { ContentBlock } from '@agentclientprotocol/sdk'

export type PiImage = {
  type: 'image'
  mimeType: string
  data: string
}

export function promptToPiMessage(blocks: ContentBlock[]): {
  message: string
  images: PiImage[]
} {
  let message = ''
  const images: PiImage[] = []

  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        message += b.text
        break

      case 'resource_link':
        // A lightweight, human-readable hint for the LLM.
        message += `\n[Context] ${b.uri}`
        break

      case 'image': {
        // pi expects base64 image bytes in `data` without a data-url prefix.
        images.push({
          type: 'image',
          mimeType: b.mimeType,
          data: b.data
        })
        break
      }

      case 'resource': {
        // Clients should not send this if embeddedContext=false, but be resilient.
        const r: any = (b as any).resource
        const uri = typeof r?.uri === 'string' ? r.uri : '(unknown)'

        if (typeof r?.text === 'string') {
          // TextResourceContents
          const mime = typeof r?.mimeType === 'string' ? r.mimeType : 'text/plain'
          message += `\n[Embedded Context] ${uri} (${mime})\n${r.text}`
        } else if (typeof r?.blob === 'string') {
          // BlobResourceContents
          const mime = typeof r?.mimeType === 'string' ? r.mimeType : 'application/octet-stream'
          const bytes = Buffer.byteLength(r.blob, 'base64')
          message += `\n[Embedded Context] ${uri} (${mime}, ${bytes} bytes)`
        } else {
          message += `\n[Embedded Context] ${uri}`
        }
        break
      }

      case 'audio': {
        // Not supported by pi. Provide a marker so we don't silently drop context.
        const bytes = Buffer.byteLength(b.data, 'base64')
        message += `\n[Audio] (${b.mimeType}, ${bytes} bytes) not supported by pi-acp`
        break
      }

      default:
        // Ignore unknown block types for now.
        break
    }
  }

  return { message, images }
}
