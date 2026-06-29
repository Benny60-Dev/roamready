import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

/**
 * Shared RV-hazard pill (FR-HAZARD-WARN-VERBOSITY). ONE component for BOTH the map
 * sidebar (notes from GET /trips/:id/hazards) and the planning panel (notes from
 * stop.violationNotes) — it replaces the two earlier copies (TripMapPage's
 * RigWarningPill and SessionPage's always-expanded RouteAdvisory). Collapsed it's a
 * small pill; clicking it reveals the full advisory text inline.
 *
 * SEVERITY is prefix-parsed (there is no structured severity field — the tier is a
 * text prefix that exists only on the curated GRADE messages). Rule, case-insensitive
 * on the leading token: a note starting with "CAUTION" or "HEADS UP" is an advisory;
 * "DANGER" — or NO prefix (the unprefixed messages are all hard legal bans:
 * length / height / width / propane, the most serious) — is a warning. The pill takes
 * the WORST tier present: any DANGER/unprefixed note → RED "Rig warning"; otherwise
 * (every note is CAUTION/HEADS UP) → AMBER "Rig advisory".
 *
 * Expanded rows all use the pill's single (worst-tier) color rather than coloring each
 * row by its own prefix — simpler, and the pill already signals the worst tier.
 *
 * Renders nothing when there are no notes.
 */
function isAdvisory(note: string): boolean {
  const t = note.trimStart().toUpperCase()
  return t.startsWith('CAUTION') || t.startsWith('HEADS UP') || t.startsWith('HEADS-UP')
}

export default function RigWarningPill({ notes }: { notes?: string[] | null }) {
  const [open, setOpen] = useState(false)
  if (!Array.isArray(notes)) return null
  const unique = Array.from(new Set(notes.filter(n => typeof n === 'string' && n.trim() !== '')))
  if (unique.length === 0) return null

  // Worst tier wins: RED unless EVERY note is an advisory (CAUTION / HEADS UP).
  const danger = unique.some(n => !isAdvisory(n))
  const label = danger ? 'Rig warning' : 'Rig advisory'

  const pillCls = danger
    ? 'bg-red-100 text-red-800 hover:bg-red-200 border-red-300'
    : 'bg-amber-100 text-amber-800 hover:bg-amber-200 border-amber-300'
  const rowCls = danger ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'
  const rowIconCls = danger ? 'text-red-600' : 'text-amber-600'
  const rowTextCls = danger ? 'text-red-800' : 'text-amber-800'

  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        aria-expanded={open}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${pillCls}`}
        style={{ borderWidth: '0.5px' }}
      >
        <AlertTriangle size={11} className="flex-shrink-0" /> {label}
      </button>
      {open && (
        <div className="mt-1 space-y-1" onClick={(e) => e.stopPropagation()}>
          {unique.map((vn, k) => (
            <div
              key={k}
              className={`flex items-start gap-1 rounded px-1.5 py-1 border ${rowCls}`}
              style={{ borderWidth: '0.5px' }}
            >
              <AlertTriangle size={11} className={`${rowIconCls} flex-shrink-0 mt-0.5`} />
              <span className={`text-[11px] leading-snug ${rowTextCls}`}>
                {vn} — verify the road is open for your dates and rig before driving.
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
