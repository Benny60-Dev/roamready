import { create } from 'zustand'
import { Trip, Stop } from '../types'

interface TripState {
  trips: Trip[]
  activeTrip: Trip | null
  setTrips: (trips: Trip[]) => void
  setActiveTrip: (trip: Trip | null) => void
  updateTrip: (id: string, data: Partial<Trip>) => void
  addStop: (tripId: string, stop: Stop) => void
  updateStop: (tripId: string, stopId: string, data: Partial<Stop>) => void
  removeStop: (tripId: string, stopId: string) => void
}

export const useTripStore = create<TripState>((set) => ({
  trips: [],
  activeTrip: null,
  setTrips: (trips) => set({ trips }),
  setActiveTrip: (activeTrip) => set({ activeTrip }),
  updateTrip: (id, data) =>
    set(state => ({
      trips: state.trips.map(t => t.id === id ? { ...t, ...data } : t),
      activeTrip: state.activeTrip?.id === id ? { ...state.activeTrip, ...data } : state.activeTrip,
    })),
  addStop: (tripId, stop) =>
    set(state => ({
      trips: state.trips.map(t => t.id === tripId ? { ...t, stops: [...(t.stops || []), stop] } : t),
      activeTrip: state.activeTrip?.id === tripId
        ? { ...state.activeTrip, stops: [...(state.activeTrip.stops || []), stop] }
        : state.activeTrip,
    })),
  updateStop: (tripId, stopId, data) =>
    set(state => {
      const updateStops = (stops: Stop[]) => stops.map(s => s.id === stopId ? { ...s, ...data } : s)
      return {
        trips: state.trips.map(t => t.id === tripId ? { ...t, stops: updateStops(t.stops || []) } : t),
        activeTrip: state.activeTrip?.id === tripId
          ? { ...state.activeTrip, stops: updateStops(state.activeTrip.stops || []) }
          : state.activeTrip,
      }
    }),
  removeStop: (tripId, stopId) =>
    set(state => {
      const filterStops = (stops: Stop[]) => stops.filter(s => s.id !== stopId)
      return {
        trips: state.trips.map(t => t.id === tripId ? { ...t, stops: filterStops(t.stops || []) } : t),
        activeTrip: state.activeTrip?.id === tripId
          ? { ...state.activeTrip, stops: filterStops(state.activeTrip.stops || []) }
          : state.activeTrip,
      }
    }),
}))
