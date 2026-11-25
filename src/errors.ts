/**
 * An error whose message is meant for the model, not the logs.
 *
 * The hint is folded into the message because an MCP client only sees
 * `error.message`; keeping it in a separate field would hide it.
 */
export class ToolError extends Error {
  constructor(message: string, hint?: string) {
    super(hint ? `${message} (${hint})` : message)
    this.name = "ToolError"
  }
}

/** The upstream answered, but not with something we can use. */
export class UpstreamError extends ToolError {
  constructor(
    readonly url: string,
    readonly status: number,
    detail?: string,
  ) {
    super(
      `upstream ${status} for ${url}${detail ? `: ${detail}` : ""}`,
      status === 403 || status === 429
        ? "the site is rate limiting or blocking this worker's IP; retry later or fall back to another source"
        : undefined,
    )
    this.name = "UpstreamError"
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
