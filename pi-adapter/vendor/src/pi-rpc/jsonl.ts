/**
 * Strict JSONL framing for pi's RPC stdout: records end at LF (an optional
 * preceding CR is stripped) and NOWHERE else.
 *
 * Node's `readline` is not usable here: it also treats U+2028 / U+2029 as line
 * breaks, and those are valid characters inside a JSON string. A model reply
 * containing one would be torn into two unparseable halves and the event lost.
 *
 * Bytes are buffered until an LF arrives, then decoded as one UTF-8 string, so
 * a multi-byte character split across two chunks is reassembled intact.
 */
export class JsonlSplitter {
  private buffered: Buffer[] = []
  private bufferedLength = 0

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    let start = 0
    let newline = chunk.indexOf(0x0a, start)
    while (newline !== -1) {
      this.emit(chunk.subarray(start, newline))
      start = newline + 1
      newline = chunk.indexOf(0x0a, start)
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      this.buffered.push(rest)
      this.bufferedLength += rest.length
    }
  }

  /** Flush a final record that was not LF-terminated. */
  end(): void {
    if (this.bufferedLength === 0) return
    this.emit(Buffer.alloc(0))
  }

  private emit(tail: Buffer): void {
    let bytes: Buffer
    if (this.bufferedLength === 0) {
      bytes = tail
    } else {
      bytes = Buffer.concat([...this.buffered, tail], this.bufferedLength + tail.length)
      this.buffered = []
      this.bufferedLength = 0
    }
    let line = bytes.toString('utf8')
    if (line.endsWith('\r')) line = line.slice(0, -1)
    this.onLine(line)
  }
}
