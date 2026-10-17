import type { WorkTask } from "@/lib/types"

/** The query as lower-cased terms. Every term has to match somewhere — a
 *  search box narrows, so two words mean "both", not "either". */
export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

/**
 * Whether `task` matches every term.
 *
 * Searched: what a task is recognised by — its title, its number, its branch,
 * its project folder, the agent that runs it and, for a task someone wrote,
 * its description.
 *
 * NOT searched for a forge task: its description. That text is the panel's
 * built-in instruction ("Handle issue #7 …: judge the report first, then fix
 * it …"), the same few hundred words on every forge task, so searching it
 * would make "fix" or "report" match all of them. What identifies a forge task
 * is its item instead — repository, number and the item's own title — and
 * those are searched.
 *
 * `#12` is an exact NUMBER: the task's own id, or its forge item's number.
 * Someone typing `#12` does not mean task #112 or issue #1201.
 */
export function taskMatchesSearch(
  task: WorkTask,
  terms: string[],
  folderName: string | null
): boolean {
  if (terms.length === 0) return true
  const text = searchableText(task, folderName)
  return terms.every((term) => {
    const number = /^#(\d+)$/.exec(term)
    if (number) {
      const wanted = Number(number[1])
      return task.id === wanted || task.source_meta?.number === wanted
    }
    return text.includes(term)
  })
}

function searchableText(task: WorkTask, folderName: string | null): string {
  const meta = task.source_meta
  const parts: (string | null | undefined)[] = [
    task.title,
    // A bare `12` still finds task #12 (and #112) by substring; only the
    // `#12` spelling is exact — see `taskMatchesSearch`.
    `#${task.id}`,
    task.work_branch,
    task.base_branch,
    folderName,
    task.agent_type,
  ]
  if (meta) {
    parts.push(
      meta.owner_repo,
      `${meta.owner_repo}#${meta.number}`,
      meta.title,
      meta.url
    )
  } else {
    parts.push(task.config?.display_text)
  }
  return parts
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n")
    .toLowerCase()
}
