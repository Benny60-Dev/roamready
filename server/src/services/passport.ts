import passport from 'passport'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20'
import { prisma } from '../utils/prisma'
import { isFounderEligible } from '../config/founderPricing'

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || 'placeholder',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'placeholder',
      callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/v1/auth/google/callback',
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value
        if (!email) return done(new Error('No email from Google'), undefined)

        let user = await prisma.user.findFirst({
          where: { OR: [{ googleId: profile.id }, { email }] },
        })

        if (!user) {
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
            } as any,
          })

          // Stripe customer is lazily created on first checkout — see the
          // recovery path in createCheckout (controllers/subscriptions.ts).
        } else if (!user.googleId) {
          await prisma.user.update({ where: { id: user.id }, data: { googleId: profile.id } })
        }

        done(null, user)
      } catch (err) {
        done(err as Error, undefined)
      }
    }
  )
)

export default passport
