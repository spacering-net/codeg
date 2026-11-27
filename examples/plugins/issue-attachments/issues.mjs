const issues = [
  {
    id: "issue-104",
    identifier: "DEMO-104",
    title: "Document the first-run workflow",
    subtitle: "Docs · Open",
    url: "https://example.com/issues/DEMO-104",
    text: "DEMO-104 · Document the first-run workflow\n\nAdd instructions for creating a workspace and opening a first session.",
    resourceType: "issue",
  },
  {
    id: "issue-108",
    identifier: "DEMO-108",
    title: "Show an empty state for archived workspaces",
    subtitle: "UI · In progress",
    url: "https://example.com/issues/DEMO-108",
    text: "DEMO-108 · Show an empty state for archived workspaces\n\nExplain how to restore a workspace when the archive is empty.",
    resourceType: "issue",
  },
  {
    id: "issue-112",
    identifier: "DEMO-112",
    title: "Add an import example",
    subtitle: "Docs · Open",
    url: "https://example.com/issues/DEMO-112",
    text: "DEMO-112 · Add an import example\n\nShow how to import a workspace from an existing local directory.",
    resourceType: "issue",
  },
]

export function handle(method, input) {
  const query = input?.query
  if (method !== "search-issues" || typeof query !== "string") {
    throw new Error("Expected the search-issues method and a query string")
  }

  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  const items = issues
    .filter(({ identifier, title, subtitle, text }) => {
      const searchable =
        `${identifier} ${title} ${subtitle} ${text}`.toLowerCase()
      return terms.every((term) => searchable.includes(term))
    })
    .slice(0, 20)
  return { items }
}
