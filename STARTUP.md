# RoamReady — Local Development Setup

## Prerequisites
- Node.js 18+
- Docker Desktop
- Git

## First-time setup

### 1. Start the database and cache
```bash
docker-compose up -d
```

### 2. Add your API keys
Edit `.env` in the root and `client/.env`:

**Required to start:**
- `JWT_SECRET` and `JWT_REFRESH_SECRET` — any random string

**Required for full features:**
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `GOOGLE_MAPS_API_KEY` — from Google Cloud Console (Maps JS API + Places API)
- `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` — from Stripe dashboard
- `OPENWEATHER_API_KEY` — from openweathermap.org

### 3. Run database migrations
```bash
cd server
npm run db:migrate
npm run db:seed    # Seeds rig database
```

### 4. Start development servers
```bash
# From root
npm run dev

# Or separately:
cd server && npm run dev    # http://localhost:3001
cd client && npm run dev    # http://localhost:3000
```

## App URLs
- **Frontend:** http://localhost:3000
- **API:** http://localhost:3001/api/v1
- **Health check:** http://localhost:3001/api/health
- **Prisma Studio:** `cd server && npm run db:studio`

## Key features
- Sign up → starts 7-day Pro trial automatically
- `/trips/new` → AI planner chat (requires ANTHROPIC_API_KEY)
- `/admin` → owner dashboard (set `isOwner: true` in DB for your user)
- Stripe webhooks → `stripe listen --forward-to localhost:3001/api/v1/subscriptions/webhook`

## Stripe setup
Create these products in your Stripe dashboard:
- Pro Monthly: $8.99/mo
- Pro Annual: $69.99/yr
- Pro+ Monthly: $12.99/mo
- Pro+ Annual: $109.99/yr

Add the price IDs to `.env` and `client/.env`.
