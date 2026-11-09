export class InputError extends Error {}
export function problem(statusCode, message) {
  return Object.assign(new Error(message), { statusCode, publicMessage: message })
}
