import { BookOpenText } from "lucide-react"

import type { AvailableCommandInfo } from "@/lib/types"

import {
  commandInputHint,
  commandInvocationToken,
} from "./invocation-reference"

/**
 * One advertised command as a composer's `/` popup lists it: the token it runs
 * as, the argument the agent says it takes, then its description. Shared by
 * the chat composer and the automation editor so the two rows stay identical.
 *
 * In a menu that shows skills (`kindColumn`, see `skillMarkedCommands`) every
 * row starts with a column for the skill icon, the one the menus give a skill
 * read from disk, so the tokens of skills and commands line up. Hovering a
 * skill's token shows its `SKILL.md` when the agent sent the path.
 */
export function CommandOptionLabel({
  command,
  skill = false,
  kindColumn = false,
}: {
  command: AvailableCommandInfo
  /** Show the row as a skill. */
  skill?: boolean
  /** The menu shows skills: keep the icon column on every row. */
  kindColumn?: boolean
}) {
  const hint = commandInputHint(command)
  const skillPath = skill ? command.skill_path || undefined : undefined
  return (
    <>
      {kindColumn ? (
        <span
          className="flex size-4 shrink-0 items-center justify-center"
          data-command-kind={skill ? "skill" : "command"}
        >
          {skill ? (
            <BookOpenText className="size-4 text-primary/80" aria-hidden />
          ) : null}
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-primary" title={skillPath}>
        {commandInvocationToken(command.name)}
      </span>
      {hint ? (
        <span
          className="max-w-[40%] shrink-0 truncate font-mono text-xs text-muted-foreground/80"
          title={hint}
        >
          {hint}
        </span>
      ) : null}
      <span className="truncate text-xs text-muted-foreground">
        {command.description}
      </span>
    </>
  )
}
