/**
 * Whether an event is the owner's own — a real click or key press, not one
 * a script dispatched (`isTrusted`). Its own module so a test can stand in
 * for a real click: jsdom's events are never trusted.
 */
export function isOwnerGesture(
  event: { nativeEvent?: Event } | Event
): boolean {
  const native =
    "nativeEvent" in event && event.nativeEvent
      ? event.nativeEvent
      : (event as Event)
  return native.isTrusted === true
}
