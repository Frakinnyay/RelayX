export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown): AppError =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Missing or invalid API key'): AppError =>
  new AppError(401, 'UNAUTHORIZED', message);
export const notFound = (what: string): AppError => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string): AppError => new AppError(409, code, message);
export const tooManyRequests = (message: string): AppError => new AppError(429, 'RATE_LIMITED', message);
