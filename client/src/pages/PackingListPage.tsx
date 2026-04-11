import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Wand2, Check, Loader } from 'lucide-react'
import { tripsApi } from '../services/api'
import { PackingCategory } from '../types'
import { Breadcrumb } from '../components/ui/Breadcrumb'

export default function PackingListPage() {
  const { tripId } = useParams<{ tripId: string }>()
  const [categories, setCategories] = useState<PackingCategory[]>([])
  const [tripName, setTripName] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    if (!tripId) return
    tripsApi.get(tripId).then(res => {
      setTripName(res.data.name ?? '')
      if (res.data.packingList) setCategories(res.data.packingList)
      setLoading(false)
    })
  }, [tripId])

  async function generate() {
    if (!tripId) return
    setGenerating(true)
    try {
      const res = await tripsApi.generatePackingList(tripId)
      setCategories(res.data)
    } finally {
      setGenerating(false)
    }
  }

  function toggleItem(catIdx: number, itemIdx: number) {
    setCategories(prev => prev.map((cat, ci) =>
      ci === catIdx ? {
        ...cat,
        items: cat.items.map((item, ii) => ii === itemIdx ? { ...item, checked: !item.checked } : item)
      } : cat
    ))
  }

  const totalItems = categories.reduce((sum, cat) => sum + cat.items.length, 0)
  const checkedItems = categories.reduce((sum, cat) => sum + cat.items.filter(i => i.checked).length, 0)
  const progress = totalItems > 0 ? Math.round((checkedItems / totalItems) * 100) : 0

  if (loading) return <div className="flex justify-center py-20"><div className="w-6 h-6 border-2 border-[#1D9E75] border-t-transparent rounded-full animate-spin" /></div>

  return (
    <div className="space-y-4 max-w-2xl">
      <Breadcrumb items={[
        { label: 'My Trips', href: '/trips' },
        { label: tripName || 'Trip', href: `/trips/${tripId}/map` },
        { label: 'Packing List' },
      ]} />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-gray-900">Packing List</h1>
        <div className="flex gap-2">
          <button onClick={generate} disabled={generating} className="btn-outline text-sm flex items-center gap-1.5">
            {generating ? <Loader size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {generating ? 'Generating...' : categories.length ? 'Regenerate' : 'Generate with AI'}
          </button>
        </div>
      </div>

      {categories.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-600">{checkedItems} of {totalItems} packed</span>
            <span className="text-sm font-medium text-[#1D9E75]">{progress}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-[#1D9E75] rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {categories.length === 0 ? (
        <div className="card text-center py-16">
          <div className="text-4xl mb-3">🎒</div>
          <p className="font-medium text-gray-700 mb-1">No packing list yet</p>
          <p className="text-sm text-gray-500 mb-4">Generate one with AI based on your trip details</p>
          <button onClick={generate} disabled={generating} className="btn-primary inline-flex items-center gap-2">
            {generating ? <Loader size={15} className="animate-spin" /> : <Wand2 size={15} />}
            Generate packing list
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {categories.map((cat, ci) => (
            <div key={ci} className="card-lg">
              <h3 className="font-medium text-gray-900 mb-3">{cat.category}</h3>
              <div className="space-y-2">
                {cat.items.map((item, ii) => (
                  <label key={ii} className="flex items-center gap-3 cursor-pointer group">
                    <div className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                      item.checked ? 'bg-[#1D9E75] border-[#1D9E75]' : 'border-gray-300 group-hover:border-[#1D9E75]'
                    }`} style={{ borderWidth: '0.5px' }}
                      onClick={() => toggleItem(ci, ii)}
                    >
                      {item.checked && <Check size={12} className="text-white" />}
                    </div>
                    <span className={`text-sm transition-colors ${item.checked ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                      {item.name}
                      {item.required && <span className="text-red-400 ml-1">*</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
