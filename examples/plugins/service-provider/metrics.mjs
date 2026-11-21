export function handle(method, input, settings) {
  if (method !== "summarize") {
    throw new Error(`Unknown method: ${method}`)
  }

  const { fileCount } = input
  return { fileCount, score: fileCount * settings.weight }
}
