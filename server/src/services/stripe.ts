import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2024-06-20',
})

export async function createStripeCustomer(email: string, name: string) {
  return stripe.customers.create({ email, name })
}

export async function createCheckoutSession(
  customerId: string,
  priceId: string,
  userId: string,
  clientOrigin: string,
  /** When true, force trial_period_days to 0 so this checkout cannot grant a
   *  trial — used for users who have already had one (trialEndsAt set) OR
   *  already had a Stripe customer record before this checkout request. The
   *  client paywall hides "Start free trial" framing for the same audience;
   *  this is the server-side enforcement that makes that promise truthful. */
  enforceNoTrial = false,
) {
  return stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'subscription',
    success_url: `${clientOrigin}/profile/billing?success=true`,
    cancel_url: `${clientOrigin}/pricing`,
    metadata: { userId },
    subscription_data: {
      metadata: { userId },
      ...(enforceNoTrial ? { trial_period_days: 0 } : {}),
    },
  })
}

export async function createPortalSession(customerId: string, clientOrigin: string) {
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${clientOrigin}/profile/billing`,
  })
}
