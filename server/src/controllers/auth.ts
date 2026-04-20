import { Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Resend } from 'resend'
import { prisma } from '../utils/prisma'
import { AppError } from '../middleware/errorHandler'
import { AuthRequest } from '../middleware/auth'
import { createStripeCustomer } from '../services/stripe'

const resend = new Resend(process.env.RESEND_API_KEY)

// When requests arrive via Vite's dev proxy (e.g. from http://10.0.0.214:3000),
// the proxy sets x-forwarded-host to the original hostname:port.
// This lets server-side redirects go back to the correct host instead of localhost.
function getClientOrigin(req: Request): string {
  const fwdHost = req.headers['x-forwarded-host']
  if (fwdHost) {
    const host = Array.isArray(fwdHost) ? fwdHost[0] : fwdHost
    const proto = Array.isArray(req.headers['x-forwarded-proto'])
      ? req.headers['x-forwarded-proto'][0]
      : (req.headers['x-forwarded-proto'] as string | undefined) || 'http'
    return `${proto}://${host}`
  }
  return process.env.CLIENT_URL || 'http://localhost:3000'
}

function generateTokens(userId: string) {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: '15m' })
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET!, { expiresIn: '30d' })
  return { accessToken, refreshToken }
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
}

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, firstName, lastName } = req.body
    if (!email || !password || !firstName || !lastName) {
      throw new AppError('All fields required', 400)
    }

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new AppError('Email already in use', 409)

    const passwordHash = await bcrypt.hash(password, 12)
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const user = await prisma.user.create({
      data: {
        email,
        firstName,
        lastName,
        passwordHash,
        subscriptionTier: 'FREE',
        trialEndsAt,
      },
    })

    // Create Stripe customer
    try {
      const customer = await createStripeCustomer(user.email, `${user.firstName} ${user.lastName}`)
      await prisma.user.update({ where: { id: user.id }, data: { customerId: customer.id } })
    } catch (e) {
      console.error('Stripe customer creation failed:', e)
    }

    const { accessToken, refreshToken } = generateTokens(user.id)
    setRefreshCookie(res, refreshToken)

    res.status(201).json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        subscriptionTier: user.subscriptionTier,
        trialEndsAt: user.trialEndsAt,
      },
    })
  } catch (err) {
    next(err)
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body
    if (!email || !password) throw new AppError('Email and password required', 400)

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user || !user.passwordHash) throw new AppError('Invalid credentials', 401)

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) throw new AppError('Invalid credentials', 401)

    const { accessToken, refreshToken } = generateTokens(user.id)
    setRefreshCookie(res, refreshToken)

    res.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        subscriptionTier: user.subscriptionTier,
        trialEndsAt: user.trialEndsAt,
        isOwner: user.isOwner,
      },
    })
  } catch (err) {
    next(err)
  }
}

export async function logout(_req: Request, res: Response) {
  res.clearCookie('refreshToken')
  res.json({ message: 'Logged out' })
}

export async function refreshToken(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies.refreshToken
    if (!token) throw new AppError('No refresh token', 401)

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as { userId: string }
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } })
    if (!user) throw new AppError('User not found', 401)

    const tokens = generateTokens(user.id)
    setRefreshCookie(res, tokens.refreshToken)

    res.json({ accessToken: tokens.accessToken })
  } catch (err) {
    next(new AppError('Invalid refresh token', 401))
  }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body
    const user = await prisma.user.findUnique({ where: { email } })

    // Always return success to prevent email enumeration
    if (!user) return res.json({ message: 'If that email exists, a reset link was sent.' })

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const resetUrl = `${getClientOrigin(req)}/reset-password?token=${token}`

    console.log('Password reset token for', email, ':', token)

    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL!,
        to: email,
        subject: 'Reset your RoamReady password',
        html: `
          <p>Hi ${user.firstName},</p>
          <p>We received a request to reset your RoamReady password. Click the link below to choose a new one:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
          <p>— The RoamReady Team</p>
        `,
        text: `Hi ${user.firstName},\n\nWe received a request to reset your RoamReady password.\n\nReset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.\n\n— The RoamReady Team`,
      })
      console.log('[email] password reset email sent to', email)
    } catch (emailErr: any) {
      console.error('[email] password reset email FAILED:', emailErr?.message)
    }

    res.json({ message: 'If that email exists, a reset link was sent.' })
  } catch (err) {
    next(err)
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, password } = req.body
    if (!token || !password) throw new AppError('Token and password required', 400)

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string }
    const passwordHash = await bcrypt.hash(password, 12)

    await prisma.user.update({
      where: { id: decoded.userId },
      data: { passwordHash },
    })

    res.json({ message: 'Password updated' })
  } catch (err) {
    next(new AppError('Invalid or expired token', 400))
  }
}

export async function getMe(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        rigs: true,
        travelProfile: true,
        memberships: { where: { isActive: true } },
      },
    })
    res.json(user)
  } catch (err) {
    next(err)
  }
}

export async function googleCallback(req: Request, res: Response) {
  const user = req.user as any
  const origin = getClientOrigin(req)
  if (!user) return res.redirect(`${origin}/login?error=auth_failed`)

  const { accessToken, refreshToken } = generateTokens(user.id)
  setRefreshCookie(res, refreshToken)

  res.redirect(`${origin}/auth/callback?token=${accessToken}`)
}

export async function appleCallback(req: Request, res: Response) {
  res.redirect(`${getClientOrigin(req)}/login?error=apple_not_configured`)
}
