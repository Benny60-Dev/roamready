import { Router } from 'express'
import {
  register,
  login,
  logout,
  refreshToken,
  forgotPassword,
  resetPassword,
  getMe,
  googleCallback,
  appleCallback,
} from '../controllers/auth'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { resendVerification, verifyEmail } from '../controllers/emailVerification'
import passport from 'passport'
import '../services/passport'

export const authRouter = Router()

authRouter.post('/register', register)
authRouter.post('/login', login)
authRouter.post('/logout', logout)
authRouter.post('/refresh', refreshToken)
authRouter.post('/forgot-password', forgotPassword)
authRouter.post('/reset-password', resetPassword)
authRouter.get('/me', requireAuth, getMe as (req: AuthRequest, res: any, next: any) => any)

// Email verification — magic-link flow. resend-verification is behind
// requireAuth (user must be logged in to request a fresh link to their
// own email); verify-email is public so the link works on any device.
authRouter.post('/resend-verification', requireAuth, resendVerification as (req: AuthRequest, res: any, next: any) => any)
authRouter.get('/verify-email', verifyEmail)

authRouter.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }))
authRouter.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/login' }),
  googleCallback
)

authRouter.get('/apple', (_req, res) => res.json({ message: 'Apple OAuth not configured' }))
authRouter.get('/apple/callback', appleCallback)
