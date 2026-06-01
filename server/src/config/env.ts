import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../../.env') })

// ADMIN_EMAIL is the recipient for the monthly OHV link-check alert (only sent
// when a link is dead). Logged here for startup visibility; missing it just
// disables that one alert email, it isn't app-critical.
const CHECK_VARS = ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'JWT_SECRET', 'ADMIN_EMAIL'] as const
const status = CHECK_VARS.map(k => `${k}=${process.env[k] ? 'present' : 'MISSING'}`).join(' | ')
console.log(`[env] loaded from ${path.resolve(__dirname, '../../../.env')} — ${status}`)
