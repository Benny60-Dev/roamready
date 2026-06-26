import { z } from 'zod'

// Body for PATCH /users/me/marketing-consent (FR-MARKETING-OPTIN). A single
// explicit boolean — true = opt in, false = "No thanks". The controller stamps
// marketingConsentAt on EITHER value, so the onboarding modal fires exactly once.
// .strict() rejects unknown keys (mass-assignment guard); no default — the client
// must send an explicit decision (CAN-SPAM: silence is never consent).
export const MarketingConsentSchema = z
  .object({
    consent: z.boolean(),
  })
  .strict()

export type MarketingConsentInput = z.infer<typeof MarketingConsentSchema>
