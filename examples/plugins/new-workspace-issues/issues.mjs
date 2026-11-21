const issues = [
  {
    id: "DEMO-12",
    slug: "workspace-search",
    title: {
      en: "Improve workspace search",
      es: "Mejorar la búsqueda de espacios",
      zh: "改进工作区搜索",
    },
  },
  {
    id: "DEMO-21",
    slug: "sidebar-keyboard",
    title: {
      en: "Add sidebar keyboard navigation",
      es: "Añadir navegación por teclado en la barra lateral",
      zh: "添加侧边栏键盘导航",
    },
  },
]

export function handle(method, input, settings) {
  if (method !== "search-issues") {
    throw new Error(`Unknown method: ${method}`)
  }

  const language = input.locale.split("-")[0]
  const query = (input.query ?? "").trim().toLowerCase()
  const items = []
  for (const issue of issues) {
    const id = issue.id.toLowerCase()
    const title = Object.hasOwn(issue.title, language)
      ? issue.title[language]
      : issue.title.en
    if (!`${id} ${title} ${issue.title.en}`.toLowerCase().includes(query)) {
      continue
    }
    items.push({
      id,
      label: `${issue.id} · ${title}`,
      patch: {
        branch: `${settings.branchPrefix}/${id}-${issue.slug}`,
        metadata: { "issues.id": issue.id },
      },
    })
  }
  return { items }
}
