import passport from 'passport'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20'
import { prisma } from '../utils/prisma'
import { createStripeCustomer } from './stripe'

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
          user = await prisma.user.create({
            data: {
              email,
              firstName: profile.name?.givenName || 'User',
              lastName: profile.name?.familyName || '',
              googleId: profile.id,
              avatarUrl: profile.photos?.[0]?.value,
              subscriptionTier: 'FREE',
              trialEndsAt,
            },
          })

          try {
            const customer = await createStripeCustomer(user.email, `${user.firstName} ${user.lastName}`)
            await prisma.user.update({ where: { id: user.id }, data: { customerId: customer.id } })
          } catch (e) {
            console.error('Stripe customer creation failed:', e)
          }
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
