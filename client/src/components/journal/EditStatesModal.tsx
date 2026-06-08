import { useState } from 'react'
import { X, Search, Lock } from 'lucide-react'
import { visitedStatesApi } from '../../services/api'
import { STATE_NAMES, STATE_CODES, type StateMeta, type StateTier } from './stateUtils'

/**
 * Edit-my-states modal (Journal map, step 6b phase 4). A searchable list of the
 * 50 states + DC where the user manually marks states the derived map can't know
 * about (drive-throughs with no stop, pre-RoamReady travel).
 *
 * Each row's display comes from stateMeta[code]:
 *   - locked (derived-overnight) → effective chip + lock, controls disabled
 *     (manual can't downgrade earned trip data).
 *   - otherwise → a 3-way control (Not yet / Passed through / Overnight)
 *     reflecting the raw manual mark; setting → upsert, "Not yet" → clear.
 *
 * Writes are Pro-gated server-side; the entry point (VisitedStatesBanner's
 * "Edit my states" button) already gates at tap, so a non-Pro user never reaches
 * this modal. The 403 branch below is just a stale-state safety net.
 *
 * Pine (#3E5540) is reserved and never used here; overnight = RV Blue #1F6F8B.
 */

const RV_BLUE = '#1F6F8B'

interface Props {
  stateMeta: Map<string, StateMeta>
  /** refetchManualStates — called after each mutation so the map updates live. */
  onChanged: () => void
  onClose: () => void
}

const EMPTY_META: StateMeta = { derivedTier: 'none', manualTier: 'none', locked: false }

function effectiveTier(m: StateMeta): StateTier {
  if (m.derivedTier === 'overnight' || m.manualTier === 'overnight') return 'overnight'
  if (m.derivedTier === 'passthrough' || m.manualTier === 'passthrough') return 'passthrough'
  return 'none'
}

function StatusChip({ tier }: { tier: StateTier }) {
  if (tier === 'overnight') {
    return (
      <span className="text-[11px] px-1.5 py-0.5 rounded text-white" style={{ background: RV_BLUE }}>
        Overnight
      </span>
    )
  }
  if (tier === 'passthrough') {
    return (
      <span
        className="text-[11px] px-1.5 py-0.5 rounded text-[#1F6F8B] border border-[#1F6F8B]/30"
        style={{ backgroundImage: `repeating-linear-gradient(45deg, ${RV_BLUE}1f 0 3px, transparent 3px 6px)` }}
      >
        Passed through
      </span>
    )
  }
  return <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Not yet</span>
}

const SEGMENTS: { tier: StateTier; label: string }[] = [
  { tier: 'none', label: 'Not yet' },
  { tier: 'passthrough', label: 'Passed' },
  { tier: 'overnight', label: 'Overnight' },
]

export default function EditStatesModal({ stateMeta, onChanged, onClose }: Props) {
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const q = search.trim().toLowerCase()
  const codes = STATE_CODES.filter(code => {
    if (!q) return true
    return code.toLowerCase().includes(q) || STATE_NAMES[code].toLowerCase().includes(q)
  })

  async function setTier(code: string, current: StateTier, next: StateTier) {
    if (next === current) return // no-op: already this manual state
    setBusy(code)
    try {
      if (next === 'none') {
        await visitedStatesApi.remove(code)
      } else {
        await visitedStatesApi.upsert(code, next)
      }
      onChanged()
    } catch (e: any) {
      // Stale-state safety net: the global interceptor opens the PaywallModal on
      // a 403 FEATURE_GATED; swallow so it isn't double-narrated.
      if (!(e?.response?.status === 403 && e?.response?.data?.code === 'FEATURE_GATED')) {
        console.error('[EditStatesModal] mutation failed:', e)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl border border-gray-200 w-full max-w-lg p-6 flex flex-col max-h-[85vh]"
        style={{ borderWidth: '0.5px' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-medium text-gray-900">Edit my states</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Mark states you drove through or visited before RoamReady. States from your
          completed trips are filled in automatically and can't be changed here.
        </p>

        {/* Search */}
        <div className="relative mb-3">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            className="input pl-8"
            placeholder="Search states..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto -mx-2 px-2">
          {codes.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No states match “{search}”.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {codes.map(code => {
                const meta = stateMeta.get(code) ?? EMPTY_META
                const effective = effectiveTier(meta)
                const rowBusy = busy === code
                return (
                  <li key={code} className="py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate">
                          {STATE_NAMES[code]}
                        </span>
                        <StatusChip tier={effective} />
                      </div>
                      {meta.locked ? (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-gray-400">
                          <Lock size={10} aria-hidden="true" /> from your trips
                        </span>
                      ) : meta.manualTier !== 'none' ? (
                        <span className="mt-0.5 inline-block text-[11px] text-gray-400">manual</span>
                      ) : meta.derivedTier !== 'none' ? (
                        <span className="mt-0.5 inline-block text-[11px] text-gray-400">from your trips</span>
                      ) : null}
                    </div>

                    {meta.locked ? (
                      <span className="flex items-center gap-1 text-[11px] text-gray-400 flex-shrink-0">
                        <Lock size={12} aria-hidden="true" /> Locked
                      </span>
                    ) : (
                      <div
                        className="inline-flex rounded-lg overflow-hidden border border-gray-200 flex-shrink-0"
                        style={{ borderWidth: '0.5px' }}
                        role="group"
                        aria-label={`Set ${STATE_NAMES[code]} status`}
                      >
                        {SEGMENTS.map(seg => {
                          const active = meta.manualTier === seg.tier
                          return (
                            <button
                              key={seg.tier}
                              type="button"
                              disabled={rowBusy}
                              onClick={() => setTier(code, meta.manualTier, seg.tier)}
                              className={`px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                                active
                                  ? 'bg-[#1F6F8B] text-white'
                                  : 'bg-white text-gray-600 hover:bg-gray-50'
                              }`}
                              aria-pressed={active}
                            >
                              {seg.label}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-end mt-4 pt-3 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
