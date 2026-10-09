import type { AppError } from '../shared/types';

export class ApiError extends Error {
  code: string;
  details?: string;
  status: number;

  constructor(error: AppError, status = 0) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.details = error.details;
    this.status = status;
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, options);
  } catch (error) {
    throw new ApiError({ code: 'connection_error', message: 'Could not reach the local server. Check that the app is running.', details: error instanceof Error ? error.message : undefined });
  }
  if (!response.ok) {
    let body: { error?: AppError | string; message?: string; code?: string; details?: string } = {};
    try { body = await response.json(); } catch { /* A proxy may return a non-JSON error. */ }
    const error = typeof body.error === 'object' && body.error
      ? body.error
      : { code: body.code ?? `http_${response.status}`, message: typeof body.error === 'string' ? body.error : body.message ?? `The request failed (${response.status}).`, details: body.details };
    throw new ApiError(error, response.status);
  }
  return response.json() as Promise<T>;
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function errorInfo(error: unknown): AppError {
  return error instanceof ApiError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: 'client_error', message: error instanceof Error ? error.message : 'Something went wrong.' };
}
