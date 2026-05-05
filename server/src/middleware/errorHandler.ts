import { Request, Response, NextFunction } from 'express'

export class AppError extends Error {
  statusCode: number
  isOperational: boolean
  // Optional extra fields the handler will spread into the JSON body alongside `error`.
  // Used by requireFeature to surface { code: 'FEATURE_GATED', feature: '<name>' }
  // so the client can route 403s to the paywall modal without parsing the message.
  details?: Record<string, unknown>

  constructor(message: string, statusCode: number, details?: Record<string, unknown>) {
    super(message)
    this.statusCode = statusCode
    this.isOperational = true
    this.details = details
    Error.captureStackTrace(this, this.constructor)
  }
}

export function errorHandler(
  err: Error | AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.details ?? {}),
    })
  }

  console.error('Unhandled error:', err)
  return res.status(500).json({
    error: 'Internal server error',
  })
}
