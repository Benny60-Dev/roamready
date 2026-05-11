import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail'
import { createCheckout, createPortal, getStatus, getInvoices } from '../controllers/subscriptions'

export const subscriptionsRouter = Router()

subscriptionsRouter.use(requireAuth, requireVerifiedEmail)
subscriptionsRouter.post('/checkout', createCheckout as any)
subscriptionsRouter.post('/portal', createPortal as any)
subscriptionsRouter.get('/status', getStatus as any)
subscriptionsRouter.get('/invoices', getInvoices as any)
