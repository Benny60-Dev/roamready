import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getRouteWeather, getStopWeather, getLiveForecast, getHistoricalWeather } from '../controllers/weather'

export const weatherRouter = Router()
weatherRouter.use(requireAuth)
weatherRouter.get('/route',      getRouteWeather      as any)
weatherRouter.get('/stop',       getStopWeather       as any)
weatherRouter.get('/forecast',   getLiveForecast      as any)
weatherRouter.get('/historical', getHistoricalWeather as any)
