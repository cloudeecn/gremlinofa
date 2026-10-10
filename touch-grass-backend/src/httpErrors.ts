import { STATUS_CODES } from 'http';

/** An error whose message is safe to send to the client as-is. */
export class HttpError extends Error {
  override name = 'HttpError';

  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface ClassifiedError {
  status: number;
  /** Client-facing text. Never a stack trace or an internal error message. */
  message: string;
}

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof HttpError) {
    return { status: err.status, message: err.message };
  }

  // http-errors style (body-parser, send, router): `status`, plus `expose` when the message is
  // client-safe. body-parser also sets `type`.
  const httpError = err as {
    type?: unknown;
    status?: unknown;
    expose?: unknown;
    message?: unknown;
  };
  if (httpError?.type === 'entity.too.large') {
    return { status: 413, message: 'Request body exceeds 10 MB' };
  }
  if (httpError?.type === 'entity.parse.failed') {
    return { status: 400, message: 'Request body is not valid JSON' };
  }
  const status = httpError?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    if (httpError.expose === true && typeof httpError.message === 'string') {
      return { status, message: httpError.message };
    }
    // Still the client's fault (e.g. the router's 400 for a malformed %-escape in a path
    // parameter), but the message may echo raw input, so only the status text goes out.
    return { status, message: STATUS_CODES[status] ?? 'Bad request' };
  }

  return { status: 500, message: 'Internal server error' };
}
