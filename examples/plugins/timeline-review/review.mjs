export function handle(method, input, _settings, host) {
  if (method !== "record-review" || !host?.timeline) {
    throw new Error("Record a review in a saved conversation")
  }

  host.timeline.append({
    id: "review-result",
    kind: "review-result",
    version: 1,
    data: { summary: input?.summary, status: input?.status },
  })
  return { saved: true }
}
