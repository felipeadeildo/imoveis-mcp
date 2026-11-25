/** An error whose message reaches the model, so it says what to do next. */
export class ToolError extends Error {
  constructor(message: string, hint?: string) {
    super(hint ? `${message} (${hint})` : message)
    this.name = "ToolError"
  }
}

/** The site answered, but not with something we can use. */
export class UpstreamError extends ToolError {
  constructor(
    readonly url: string,
    readonly status: number,
    detail?: string,
  ) {
    super(
      `upstream ${status} for ${url}${detail ? `: ${detail}` : ""}`,
      status === 403 || status === 429
        ? "the site is blocking this worker's IP; try another source"
        : undefined,
    )
    this.name = "UpstreamError"
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
