const messages = {
  en: {
    checklist: "- [ ] Review the changes\n- [ ] Run the relevant tests",
    notice: "Checklist inserted into the draft.",
    title: "Review checklist available",
    detail: "Use Review tools to add it to your draft.",
  },
  es: {
    checklist:
      "- [ ] Revisar los cambios\n- [ ] Ejecutar las pruebas pertinentes",
    notice: "Lista de revisión insertada en el borrador.",
    title: "Lista de revisión disponible",
    detail: "Añádela al borrador desde las herramientas de revisión.",
  },
  zh: {
    checklist: "- [ ] 审查改动\n- [ ] 运行相关测试",
    notice: "已将审查清单插入草稿。",
    title: "可使用审查清单",
    detail: "通过审查工具将清单插入草稿。",
  },
}

export function handle(method, input) {
  const language = input.locale.split("-")[0]
  const copy = Object.hasOwn(messages, language)
    ? messages[language]
    : messages.en

  if (method === "review-checklist") {
    return {
      insertText: copy.checklist,
      ...(input.source === "sessionAction" ? { notice: copy.notice } : {}),
    }
  }
  if (method === "review-status") {
    if (input.folderId === null) return null
    return {
      visible: true,
      tone: "muted",
      title: copy.title,
      detail: copy.detail,
    }
  }

  throw new Error(`Unknown method: ${method}`)
}
