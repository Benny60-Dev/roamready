import { useEffect, useState } from 'react'
import { campgroundsApi } from '../services/api'

export default function CarCampingPage() {
  const [destinations, setDestinations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    campgroundsApi.getCarCamping().then(res => { setDestinations(res.data); setLoading(false) })
  }, [])

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-medium text-gray-900">Car Camping Destinations</h1>
        <p className="text-sm text-gray-500">Tent sites, walk-in, and backcountry</p>
      </div>
      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="card h-20 animate-pulse bg-gray-50" />)}</div>
      ) : (
        <div className="space-y-2">
          {destinations.map(d => (
            <div key={d.id} className="card">
              <h3 className="font-medium text-gray-900 text-sm">{d.name}</h3>
              <div className="flex flex-wrap gap-1 mt-1">
                {d.siteTypes?.map((t: string) => <span key={t} className="badge-blue text-xs">{t}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
