"use client"

import { useId, useRef, useState } from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A list of short patterns typed as chips — the rule lists of the panel's
 * auto-processing ("only these labels", "never these authors").
 *
 * Enter, a comma or leaving the field turns the typed text into a chip;
 * pasting a comma- or newline-separated list adds every entry at once;
 * Backspace in an empty field takes the last chip back. Duplicates are dropped
 * CASE-INSENSITIVELY, because that is how the patterns match — two spellings of
 * one pattern would only be one rule wearing two chips.
 *
 * Leaving the field commits on purpose: the dialog's Save button takes focus
 * before it is clicked, so text typed and never "entered" is saved rather than
 * silently thrown away.
 *
 * `suggestions` (the repository's own labels, when known) ride on a native
 * datalist — the browser's own completion, with nothing to position or trap.
 */
export function PatternListInput({
  id,
  values,
  onChange,
  placeholder,
  ariaLabel,
  removeLabel,
  suggestions,
  className,
}: {
  id?: string
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  ariaLabel: string
  /** Accessible name of a chip's remove button, given the pattern. */
  removeLabel: (pattern: string) => string
  suggestions?: readonly string[]
  className?: string
}) {
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = useId()

  const commit = (raw: string) => {
    const parts = raw
      .split(/[,\n]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    setDraft("")
    if (parts.length === 0) return
    const seen = new Set(values.map((value) => value.toLowerCase()))
    const next = [...values]
    for (const part of parts) {
      const key = part.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      next.push(part)
    }
    if (next.length !== values.length) onChange(next)
  }

  const offered = (suggestions ?? []).filter(
    (name) =>
      !values.some((value) => value.toLowerCase() === name.toLowerCase())
  )

  return (
    <div
      className={cn(
        "flex min-h-9 cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        className
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {values.map((value) => (
        <span
          key={value}
          className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-muted pl-2 pr-1 text-xs font-medium"
        >
          <span className="truncate font-mono">{value}</span>
          <button
            type="button"
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            aria-label={removeLabel(value)}
            onClick={(e) => {
              e.stopPropagation()
              onChange(values.filter((v) => v !== value))
            }}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        value={draft}
        list={offered.length > 0 ? listId : undefined}
        onChange={(e) => {
          const next = e.target.value
          // A typed separator ends the chip in progress.
          if (/[,\n]/.test(next)) commit(next)
          else setDraft(next)
        }}
        onPaste={(e) => {
          // Taken over only for a LIST: a single-line input strips the line
          // breaks out of pasted text before `onChange` could split on them,
          // which would glue a column of labels into one. The paste lands
          // where the browser would have put it — over the selection — so
          // pasting onto a selected draft replaces it rather than gluing the
          // first entry onto it.
          const pasted = e.clipboardData.getData("text")
          if (!/[,\n]/.test(pasted)) return
          e.preventDefault()
          const field = e.currentTarget
          const start = field.selectionStart ?? draft.length
          const end = field.selectionEnd ?? draft.length
          commit(draft.slice(0, start) + pasted + draft.slice(end))
        }}
        onKeyDown={(e) => {
          // An IME is still composing (Chinese, Japanese…): Enter picks the
          // candidate, it does not end the chip.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === "Enter") {
            e.preventDefault()
            commit(draft)
          } else if (e.key === "Backspace" && draft === "" && values.length) {
            e.preventDefault()
            onChange(values.slice(0, -1))
          }
        }}
        onBlur={() => commit(draft)}
        placeholder={values.length === 0 ? placeholder : undefined}
        aria-label={ariaLabel}
        className="h-6 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {offered.length > 0 ? (
        <datalist id={listId}>
          {offered.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      ) : null}
    </div>
  )
}
