import { useState } from 'react'
import { Save } from 'lucide-react'
import { notificationsApi } from '../../services/api'

const NOTIFICATION_TYPES = [
  { type: 'weather_alert', label: 'Weather alerts', sub: 'Severe weather along your route' },
  { type: 'booking_reminder', label: 'Booking reminders', sub: '7 days before arrival' },
  { type: 'maintenance_due', label: 'Maintenance due', sub: 'Service items coming up' },
  { type: 'trip_depart', label: 'Departure reminder', sub: 'Day before you leave' },
  { type: 'trial_ending', label: 'Trial ending', sub: '3 days before trial expires' },
  { type: 'campground_update', label: 'Campground updates', sub: 'Closures & alerts for your stops' },
]

export default function NotificationSettingsPage() {
  const [settings, setSettings] = useState<Record<string, { enabled: boolean; method: string[] }>>(
    Object.fromEntries(NOTIFICATION_TYPES.map(t => [t.type, { enabled: true, method: ['email'] }]))
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  function toggle(type: string) {
    setSettings(s => ({ ...s, [type]: { ...s[type], enabled: !s[type].enabled } }))
  }

  function toggleMethod(type: string, method: string) {
    setSettings(s => {
      const current = s[type].method
      const next = current.includes(method) ? current.filter(m => m !== method) : [...current, method]
      return { ...s, [type]: { ...s[type], method: next } }
    })
  }

  async function save() {
    setSaving(true)
    try {
      await notificationsApi.updateSettings(
        Object.entries(settings).map(([type, config]) => ({ type, ...config }))
      )
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-xl font-medium text-gray-900">Notifications</h1>

      <div className="card-lg space-y-4">
        {NOTIFICATION_TYPES.map(({ type, label, sub }) => (
          <div key={type} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
            <div className="flex items-start gap-3">
              <div className="relative mt-0.5">
                <input
                  type="checkbox"
                  checked={settings[type]?.enabled}
                  onChange={() => toggle(type)}
                  className="w-4 h-4 rounded text-[#1F6F8B]"
                />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">{label}</p>
                <p className="text-xs text-gray-500">{sub}</p>
                {settings[type]?.enabled && (
                  <div className="flex gap-2 mt-1">
                    {['email', 'push', 'sms'].map(method => (
                      <button
                        key={method}
                        onClick={() => toggleMethod(type, method)}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                          settings[type].method.includes(method)
                            ? 'border-[#1F6F8B] text-[#1F6F8B] bg-[#E0F0F4]'
                            : 'border-gray-200 text-gray-400'
                        }`}
                        style={{ borderWidth: '0.5px' }}
                      >
                        {method}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <button onClick={save} disabled={saving} className="btn-primary flex items-center gap-2">
        <Save size={15} /> {saving ? 'Saving...' : saved ? 'Saved!' : 'Save settings'}
      </button>
    </div>
  )
}
