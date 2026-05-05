import { Router } from 'express'
import { requireAuth, requireFeature } from '../middleware/auth'
import { getLiveForecast, getHistoricalWeather } from '../controllers/weather'

export const weatherRouter = Router()
weatherRouter.use(requireAuth)
weatherRouter.get('/forecast',   requireFeature('weatherAlerts'), getLiveForecast      as any)
weatherRouter.get('/historical', requireFeature('weatherAlerts'), getHistoricalWeather as any)
