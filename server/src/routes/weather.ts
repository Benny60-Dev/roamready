import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getLiveForecast, getHistoricalWeather } from '../controllers/weather'

export const weatherRouter = Router()
weatherRouter.use(requireAuth)
weatherRouter.get('/forecast',   getLiveForecast      as any)
weatherRouter.get('/historical', getHistoricalWeather as any)
