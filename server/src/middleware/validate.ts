import { Request, Response, NextFunction } from 'express'
import { ZodSchema, ZodError } from 'zod'

/**
 * Express middleware that parses req.body through a Zod schema.
 * On success: replaces req.body with the parsed (and stripped) result, calls next().
 * On failure: returns 400 with field-level error details.
 *
 * Use this on every mutating endpoint. Schemas should explicitly OMIT
 * server-managed fields (id, userId, tripId, createdAt, updatedAt, etc.)
 * so they cannot be mass-assigned via req.body.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const issues = result.error.issues.map(i => ({
        path: i.path.join('.'),
        message: i.message,
      }))
      return res.status(400).json({ error: 'Validation failed', issues })
    }
    req.body = result.data
    next()
  }
}
