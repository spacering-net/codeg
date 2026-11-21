export function handle(method, { name }) {
  if (method !== "greet") throw new Error("Unknown method")
  return `Hello, ${name}!`
}
