/** A count that only goes up for the window's life: what happened before
 *  what, whatever the clock does. */
let last = 0

export function stamp(): number {
  last += 1
  return last
}
