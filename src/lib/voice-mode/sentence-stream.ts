import { toSpeakableText, type SpeakableLabels } from "@/lib/speakable-text"

export function createSentenceStream(labels: SpeakableLabels) {
  let buffer = ""
  let inFence = false
  let fenceMatch = ""

  function processBuffer(force: boolean): string[] {
    const results: string[] = []

    while (buffer.length > 0) {
      if (inFence) {
        const closeIdx = buffer.indexOf(fenceMatch, fenceMatch.length)
        if (closeIdx !== -1) {
          const endIdx = closeIdx + fenceMatch.length
          const block = buffer.slice(0, endIdx)
          buffer = buffer.slice(endIdx)
          inFence = false
          const text = toSpeakableText(block, labels)
          if (text) results.push(text)
          continue
        }
        if (force) {
          const text = toSpeakableText(`${buffer}\n${fenceMatch}`, labels)
          if (text) results.push(text)
          buffer = ""
          inFence = false
        }
        break
      } else {
        const fenceRegex = /(?:^|\n)(```|~~~)/
        const fenceMatchResult = buffer.match(fenceRegex)
        const nextFenceIdx = fenceMatchResult?.index ?? -1

        let partialFenceIdx = -1
        if (!force) {
          const pMatch = buffer.match(/(?:^|\n)([`~]{1,2})$/)
          if (pMatch) {
            partialFenceIdx = pMatch.index!
          }
        }

        const bRegex = force
          ? /([.!?])(?:\s|\n|$)|([\u3002\uFF01\uFF1F])(?:\s|\n|$)?|(\n\s*\n)/
          : /([.!?])(?:\s|\n)|([\u3002\uFF01\uFF1F])|(\n\s*\n)/
        const bMatch = buffer.match(bRegex)
        const boundaryIdx = bMatch?.index ?? -1
        const boundaryEnd =
          boundaryIdx !== -1 ? boundaryIdx + bMatch![0].length : -1

        if (
          nextFenceIdx !== -1 &&
          (boundaryIdx === -1 || nextFenceIdx <= boundaryIdx)
        ) {
          const textBeforeFence = buffer.slice(0, nextFenceIdx)
          if (textBeforeFence.trim()) {
            const text = toSpeakableText(textBeforeFence, labels)
            if (text) results.push(text)
          }
          buffer = buffer.slice(nextFenceIdx).replace(/^\n/, "")
          inFence = true
          fenceMatch = fenceMatchResult![1]
          continue
        }

        if (boundaryIdx !== -1) {
          if (partialFenceIdx === -1 || boundaryIdx < partialFenceIdx) {
            const chunk = buffer.slice(0, boundaryEnd)
            buffer = buffer.slice(boundaryEnd)
            const text = toSpeakableText(chunk, labels)
            if (text) results.push(text)
            continue
          }
        }

        if (buffer.length > 400) {
          const lastSpaceIdx = buffer.lastIndexOf(" ")
          if (
            lastSpaceIdx !== -1 &&
            lastSpaceIdx > 0 &&
            (partialFenceIdx === -1 || lastSpaceIdx < partialFenceIdx)
          ) {
            const chunk = buffer.slice(0, lastSpaceIdx)
            buffer = buffer.slice(lastSpaceIdx + 1)
            const text = toSpeakableText(chunk, labels)
            if (text) results.push(text)
            continue
          } else if (partialFenceIdx === -1) {
            const chunk = buffer.slice(0, 400)
            buffer = buffer.slice(400)
            const text = toSpeakableText(chunk, labels)
            if (text) results.push(text)
            continue
          }
        }

        if (force && buffer.trim()) {
          const text = toSpeakableText(buffer, labels)
          if (text) results.push(text)
          buffer = ""
        }

        break
      }
    }

    return results
  }

  return {
    push(delta: string): string[] {
      buffer += delta
      return processBuffer(false)
    },
    flush(): string[] {
      return processBuffer(true)
    },
  }
}
