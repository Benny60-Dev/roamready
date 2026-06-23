import passport from 'passport'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20'
import { prisma } from '../utils/prisma'
import { isFounderEligible } from '../config/founderPricing'
import { isDisposableEmail } from '../utils/disposableEmails'
import { normalizeEmail } from '../utils/email'

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || 'placeholder',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'placeholder',
      callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/v1/auth/google/callback',
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const rawEmail = profile.emails?.[0]?.value
        if (!rawEmail) return done(new Error('No email from Google'), undefined)

        // Google usually returns a lowercase address, but doesn't guarantee it
        // for every Workspace domain — normalize so the lookup below and the
        // create stay consistent with the email/password path.
        const email = normalizeEmail(rawEmail)

        // Block known disposable email domains. Safety net for the edge
        // case of a Google Workspace account configured on a throwaway
        // domain — vast majority of Google sign-ins are @gmail.com so
        // this rarely triggers, but the check is cheap and consistent
        // with the email/password registration path.
        if (isDisposableEmail(email)) {
          return done(new Error('Disposable email addresses are not allowed.'), undefined)
        }

        let user = await prisma.user.findFirst({
          where: { OR: [{ googleId: profile.id }, { email }] },
        })

        if (!user) {
          // First-time Google sign-in for this email. Create the account
          // with emailVerified=true — Google has already verified the
          // email address on their side, so requiring our own magic-link
          // confirmation would be redundant friction. NO token generated,
          // NO email sent.
          const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          // Founder pricing flag stamped at signup — see auth.ts:register
          // for the parallel email/password path. Same `as any` cast for
          // the same DLL-lock reason; remove on next dev-server restart.
          const founderPricing = isFounderEligible()
          user = await prisma.user.create({
            data: {
              email,
              firstName: profile.name?.givenName || 'User',
              lastName: profile.name?.familyName || '',
              googleId: profile.id,
              avatarUrl: profile.photos?.[0]?.value,
              subscriptionTier: 'FREE',
              trialEndsAt,
              founderPricing,
              emailVerified: true,
            } as any,
          })

          // Stripe customer is lazily created on first checkout — see the
          // recovery path in createCheckout (controllers/subscriptions.ts).
        } else {
          // Existing user signing in via Google. Two cases:
          //
          //  1. Account was created via Google before (googleId already
          //     set) — nothing to do. Respect existing emailVerified.
          //  2. Account was created via email/password and never linked
          //     Google — both googleId AND (if emailVerified was false)
          //     emailVerified now flip. Google has just vouched for the
          //     email; treat that as equivalent to clicking our magic
          //     link. Token is cleared in the same write to keep the DB
          //     clean (it would still 404 verify-email since one-time
          //     use, but explicit nulling is tidier).
          const updates: Record<string, unknown> = {}
          if (!user.googleId) updates.googleId = profile.id
          if (!(user as any).emailVerified) {
            updates.emailVerified = true
            updates.emailVerificationToken = null
            console.log(
              `[google-oauth] auto-verifying email for existing user ${email} ` +
              `via Google sign-in (was unverified)`
            )
          }
          if (Object.keys(updates).length > 0) {
            user = await prisma.user.update({
              where: { id: user.id },
              data: updates as any,
            })
          }
        }

        done(null, user)
      } catch (err) {
        done(err as Error, undefined)
      }
    }
  )
)

export default passport
