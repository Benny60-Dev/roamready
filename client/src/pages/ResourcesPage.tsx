import { useEffect, useState } from 'react'
import { Breadcrumb } from '../components/ui/Breadcrumb'
import { MapPin, Phone, Star } from 'lucide-react'
import { resourcesApi } from '../services/api'

const RESOURCE_TABS = [
  { id: 'rv_repair', label: '🔧 RV Repair', desc: 'Roadside & shop repair' },
  { id: 'propane', label: '⛽ Propane', desc: 'Propane fill stations' },
  { id: 'dump_station', label: '🚽 Dump Stations', desc: 'RV waste disposal' },
  { id: 'rv_wash', label: '🚿 RV Wash', desc: 'RV & truck wash' },
  { id: 'parts_stores', label: '🏪 Parts / Gear', desc: 'RV parts & camping supplies' },
  { id: 'doggy_daycare', label: '🐶 Dog Services', desc: 'Daycare, grooming, vets' },
  { id: 'medical', label: '🏥 Medical', desc: 'Urgent care & hospitals' },
  { id: 'veterinary', label: '🐾 Veterinary', desc: 'Animal hospitals' },
]

export default function ResourcesPage() {
  const [activeTab, setActiveTab] = useState('rv_repair')
  const [resources, setResources] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [locationError, setLocationError] = useState('')

  useEffect(() => {
    navigator.geolocation.getCurrentPosition(
      pos => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setLocationError('Location access denied. Using default location.')
    )
  }, [])

  useEffect(() => {
    if (!location) return
    setLoading(true)
    resourcesApi.get(location.lat, location.lng, activeTab, 25).then(res => {
      setResources(Array.isArray(res.data) ? res.data : [])
      setLoading(false)
    }).catch(() => { setResources([]); setLoading(false) })
  }, [location, activeTab])

  return (
    <div className="space-y-4">
      <Breadcrumb items={[
        { label: 'Profile', href: '/profile' },
        { label: 'Resources' },
      ]} />
      <div>
        <h1 className="text-xl font-medium text-gray-900">Resources Along Route</h1>
        {locationError && <p className="text-xs text-amber-600 mt-1">{locationError}</p>}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {RESOURCE_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-shrink-0 px-3 py-2 rounded-lg text-sm border transition-colors ${
              activeTab === tab.id ? 'bg-[#1D9E75] text-white border-[#1D9E75]' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
            }`}
            style={{ borderWidth: '0.5px' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">{[1, 2, 3, 4].map(i => <div key={i} className="card h-20 animate-pulse bg-gray-50" />)}</div>
      ) : resources.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500 text-sm">
            {location ? 'No results found nearby.' : 'Allow location access to find resources near you.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {resources.map(r => (
            <div key={r.id} className="card flex items-start gap-3">
              <div className="w-8 h-8 bg-gray-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <MapPin size={15} className="text-[#1D9E75]" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{r.name}</p>
                {r.address && <p className="text-xs text-gray-500 mt-0.5">{r.address}</p>}
                <div className="flex items-center gap-3 mt-1">
                  {r.rating && (
                    <span className="flex items-center gap-0.5 text-xs text-amber-500">
                      <Star size={11} fill="currentColor" /> {r.rating}
                    </span>
                  )}
                  {r.isOpen !== undefined && (
                    <span className={`text-xs ${r.isOpen ? 'text-[#1D9E75]' : 'text-gray-400'}`}>
                      {r.isOpen ? 'Open now' : 'Closed'}
                    </span>
                  )}
                </div>
              </div>
              {r.phone && (
                <a href={`tel:${r.phone}`} className="flex items-center gap-1 text-xs text-[#1D9E75]">
                  <Phone size={12} /> Call
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
