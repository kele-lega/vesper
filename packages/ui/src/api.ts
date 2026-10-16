export class UnauthorizedError extends Error {
  override name = 'UnauthorizedError';
}

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    message: string,
    /** Seconds to wait before trying again, from a 429. */
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

/**
 * Calls the API with the login cookie. Every request carries x-vesper, which a
 * page on another site cannot add without a CORS preflight the server refuses.
 */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'x-vesper': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/login') throw new UnauthorizedError('需要登录');
  if (!response.ok) {
    const { error, retryAfterS } = data as { error?: string; retryAfterS?: number };
    throw new ApiError(response.status, error ?? response.statusText, retryAfterS);
  }
  return data as T;
}

/** A one-time ticket for opening a WebSocket in the next minute. */
export async function wsTicket(): Promise<string> {
  return (await api<{ ticket: string }>('POST', '/api/ws-ticket')).ticket;
}
