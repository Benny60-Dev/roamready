import { RequestHandler } from 'express'
import { AuthRequest } from '../middleware/auth'
import { Response, NextFunction } from 'express'

// Cast AuthRequest handlers to standard Express RequestHandler
export function h(fn: (req: AuthRequest, res: Response, next: NextFunction) => any): RequestHandler {
  return fn as unknown as RequestHandler
}
