import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { createCheckout, createPortal, getStatus, handleWebhook, getInvoices } from '../controllers/subscriptions'

export const subscriptionsRouter = Router()

subscriptionsRouter.post('/webhook', handleWebhook)

subscriptionsRouter.use(requireAuth)
subscriptionsRouter.post('/checkout', createCheckout as any)
subscriptionsRouter.post('/portal', createPortal as any)
subscriptionsRouter.get('/status', getStatus as any)
subscriptionsRouter.get('/invoices', getInvoices as any)
