import { useEffect, useState } from 'react'
import { Breadcrumb } from '../components/ui/Breadcrumb'
import { CheckCircle, AlertTriangle, Clock, Wrench } from 'lucide-react'
import { usersApi, maintenanceApi } from '../services/api'
import { Rig, MaintenanceItem } from '../types'
import { format } from 'date-fns'

function StatusBadge({ status }: { status: string }) {
  if (status === 'OVERDUE') return <span className="badge-red flex items-center gap-1"><AlertTriangle size={11} /> Overdue</span>
  if (status === 'DUE_SOON') return <span className="badge-amber flex items-center gap-1"><Clock size={11} /> Due soon</span>
  return <span className="badge-green flex items-center gap-1"><CheckCircle size={11} /> OK</span>
}

export default function MaintenancePage() {
  const [rigs, setRigs] = useState<Rig[]>([])
  const [activeRig, setActiveRig] = useState<string | null>(null)
  const [items, setItems] = useState<MaintenanceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [logModal, setLogModal] = useState<string | null>(null)
  const [logData, setLogData] = useState({ serviceDate: new Date().toISOString().split('T')[0], mileage: '', cost: '', notes: '' })

  useEffect(() => {
    usersApi.getRigs().then(res => {
      setRigs(res.data)
      const def = res.data.find((r: Rig) => r.isDefault) || res.data[0]
      if (def) setActiveRig(def.id)
    })
  }, [])

  useEffect(() => {
    if (!activeRig) return
    setLoading(true)
    maintenanceApi.getItems(activeRig).then(res => { setItems(res.data); setLoading(false) })
  }, [activeRig])

  async function logService() {
    if (!activeRig || !logModal) return
    await maintenanceApi.logService(activeRig, logModal, {
      ...logData,
      mileage: logData.mileage ? parseInt(logData.mileage) : undefined,
      cost: logData.cost ? parseFloat(logData.cost) : undefined,
    })
    const res = await maintenanceApi.getItems(activeRig)
    setItems(res.data)
    setLogModal(null)
  }

  const overdue = items.filter(i => i.status === 'OVERDUE')
  const dueSoon = items.filter(i => i.status === 'DUE_SOON')
  const ok = items.filter(i => i.status === 'OK')

  return (
    <div className="space-y-4 max-w-2xl">
      <Breadcrumb items={[
        { label: 'Profile', href: '/profile' },
        { label: 'Maintenance' },
      ]} />
      <h1 className="text-xl font-medium text-gray-900">Maintenance Tracker</h1>

      {rigs.length > 1 && (
        <div className="flex gap-2">
          {rigs.map(rig => (
            <button
              key={rig.id}
              onClick={() => setActiveRig(rig.id)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                activeRig === rig.id ? 'bg-[#1E3A8A] text-white border-[#1E3A8A]' : 'border-gray-200 text-gray-600'
              }`}
              style={{ borderWidth: '0.5px' }}
            >
              {rig.year} {rig.make}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="card h-16 animate-pulse bg-gray-50" />)}</div>
      ) : (
        <>
          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="card text-center">
              <div className="text-2xl font-medium text-red-500">{overdue.length}</div>
              <div className="text-xs text-gray-500">Overdue</div>
            </div>
            <div className="card text-center">
              <div className="text-2xl font-medium text-amber-500">{dueSoon.length}</div>
              <div className="text-xs text-gray-500">Due soon</div>
            </div>
            <div className="card text-center">
              <div className="text-2xl font-medium text-[#1E3A8A]">{ok.length}</div>
              <div className="text-xs text-gray-500">Up to date</div>
            </div>
          </div>

          {/* Items */}
          {[
            { label: 'Overdue', items: overdue },
            { label: 'Due soon', items: dueSoon },
            { label: 'Up to date', items: ok },
          ].map(section => section.items.length > 0 && (
            <div key={section.label}>
              <h2 className="text-sm font-medium text-gray-700 mb-2">{section.label} ({section.items.length})</h2>
              <div className="space-y-2">
                {section.items.map(item => (
                  <div key={item.id} className="card flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <Wrench size={15} className="text-gray-400 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">{item.name}</p>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {item.intervalMiles && `Every ${item.intervalMiles.toLocaleString()} miles`}
                          {item.intervalMonths && ` · Every ${item.intervalMonths} months`}
                          {item.lastServiceDate && ` · Last: ${format(new Date(item.lastServiceDate), 'MM/dd/yyyy')}`}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={item.status} />
                      <button onClick={() => setLogModal(item.id)} className="btn-outline text-xs">Log service</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {/* Log service modal */}
      {logModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30">
          <div className="bg-white rounded-xl border border-gray-200 w-full max-w-sm p-6" style={{ borderWidth: '0.5px' }}>
            <h3 className="font-medium text-gray-900 mb-4">Log Service</h3>
            <div className="space-y-3">
              <div>
                <label className="label">Service date</label>
                <input type="date" className="input" value={logData.serviceDate} onChange={e => setLogData(d => ({ ...d, serviceDate: e.target.value }))} />
              </div>
              <div>
                <label className="label">Current mileage (optional)</label>
                <input type="number" className="input" value={logData.mileage} onChange={e => setLogData(d => ({ ...d, mileage: e.target.value }))} />
              </div>
              <div>
                <label className="label">Cost (optional)</label>
                <input type="number" step="0.01" className="input" value={logData.cost} onChange={e => setLogData(d => ({ ...d, cost: e.target.value }))} />
              </div>
              <div>
                <label className="label">Notes (optional)</label>
                <input className="input" value={logData.notes} onChange={e => setLogData(d => ({ ...d, notes: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setLogModal(null)} className="btn-ghost flex-1">Cancel</button>
              <button onClick={logService} className="btn-primary flex-1">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
