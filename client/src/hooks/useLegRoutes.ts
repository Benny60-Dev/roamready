// FEAT-NAV-HANDOFF — per-leg routing data (≤3 snapped corridor waypoints +
// rigAware provenance) for pages that don't already load it the way the trip
// map does. One call to GET /trips/:id/routes per stop set; the server caches
// the answer for 24h, so the summary and booking pages don't add LVR spend.
// Delivered through a context so a deeply nested NavigateButton can pick it
// up without threading props through every card.
import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { tripsApi } from '../services/api'
import type { DirectionsWaypoint } from '../utils/directions'

export interface LegRoutes {
  waypoints: Map<string, DirectionsWaypoint[]>   // keyed by DESTINATION stop id
  rigAware: Map<string, boolean>
  loaded: boolean
}

const EMPTY: LegRoutes = { waypoints: new Map(), rigAware: new Map(), loaded: false }
const LegRoutesContext = createContext<LegRoutes>(EMPTY)

interface StopLike { id: string; order: number; latitude?: number | null; longitude?: number | null }

export function useLegRoutes(tripId: string | undefined, stops: StopLike[] | undefined): LegRoutes {
  const [data, setData] = useState<LegRoutes>(EMPTY)
  const keyRef = useRef<string>('')
  useEffect(() => {
    if (!tripId || !stops?.length) return
    const coordStops = stops.filter(s => s.latitude != null && s.longitude != null).slice().sort((a, b) => a.order - b.order)
    if (coordStops.length < 2) return
    const key = `${tripId}|` + coordStops.map(s => `${s.id}:${s.latitude},${s.longitude}`).join('|')
    if (keyRef.current === key) return
    keyRef.current = key
    tripsApi.generateRoutes(tripId)
      .then(res => {
        const rows: any[] = Array.isArray(res.data) ? res.data : []
        const waypoints = new Map<string, DirectionsWaypoint[]>()
        const rigAware = new Map<string, boolean>()
        for (const r of rows) {
          if (!r?.toStopId) continue
          if (Array.isArray(r.hereWaypoints) && r.hereWaypoints.length > 0) {
            waypoints.set(r.toStopId, r.hereWaypoints
              .filter((w: any) => typeof w?.lat === 'number' && typeof w?.lng === 'number')
              .map((w: any) => ({ lat: w.lat, lng: w.lng })))
          }
          if (typeof r.rigAware === 'boolean') rigAware.set(r.toStopId, r.rigAware)
        }
        setData({ waypoints, rigAware, loaded: true })
      })
      .catch(err => {
        console.warn('[useLegRoutes] routes fetch failed (links fall back to plain directions):', err?.message)
        setData({ ...EMPTY, loaded: true })
      })
  }, [tripId, stops])
  return data
}

export function LegRoutesProvider({ value, children }: { value: LegRoutes; children: ReactNode }) {
  return createElement(LegRoutesContext.Provider, { value }, children)
}

export function useLegRoutesContext(): LegRoutes {
  return useContext(LegRoutesContext)
}
