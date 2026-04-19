import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../../.env') })

const CHECK_VARS = ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'JWT_SECRET'] as const
const status = CHECK_VARS.map(k => `${k}=${process.env[k] ? 'present' : 'MISSING'}`).join(' | ')
console.log(`[env] loaded from ${path.resolve(__dirname, '../../../.env')} — ${status}`)
