import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Wand2, Check, Loader, X, FileDown, Undo2, Plus, Pencil, ChevronDown } from 'lucide-react'
import { tripsApi } from '../services/api'
import { PackingCategory } from '../types'
import { Breadcrumb } from '../components/ui/Breadcrumb'
import ConfirmModal from '../components/ui/ConfirmModal'
import { useScrollResetOnReady } from '../hooks/useScrollResetOnReady'
import { formatTripDate } from '../utils/dates'

const SAVE_DEBOUNCE_MS = 500

export default function PackingListPage() {
  const { tripId } = useParams<{ tripId: string }>()
  const [categories, setCategories] = useState<PackingCategory[]>([])
  const [tripName, setTripName] = useState('')
  const [dateRange, setDateRange] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [saveError, setSaveError] = useState(false)
  // Confirm gate for Regenerate (mirrors the trip itinerary's Regenerate
  // confirm): regenerating REPLACES the list — packed checkmarks carry over
  // by name, but removed items come back and custom curation is lost.
  const [showRegenConfirm, setShowRegenConfirm] = useState(false)
  // Step 2 add/rename state. Kept here in the unconditional top hook section —
  // the loading early-return lives below (Rules of Hooks). addText is keyed by
  // category index; editing pins the row being renamed inline.
  const [addText, setAddText] = useState<Record<number, string>>({})
  const [editing, setEditing] = useState<{ ci: number; ii: number } | null>(null)
  const [editText, setEditText] = useState('')
  // Step 3: export-format dropdown (blank vs current-state PDF). Open state +
  // a ref for the click-away handler — both top-section hooks.
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  // Debounced persistence (PUT /trips/:id/packing-list). Toggles/removals
  // update local state optimistically and schedule a save; latestRef always
  // holds the current list so a delayed timer never writes stale data. The
  // dirty flag lets the unmount cleanup flush a pending save instead of
  // dropping the last <500ms of toggles.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef<PackingCategory[]>([])
  const dirtyRef = useRef(false)
  // Set when Escape cancels an inline rename, so the input's onBlur (which fires
  // on the programmatic blur) skips the save instead of committing.
  const escapeRename = useRef(false)
  useEffect(() => { latestRef.current = categories }, [categories])

  // Close the export-format menu on any outside click.
  useEffect(() => {
    if (!exportMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [exportMenuOpen])

  async function persist() {
    if (!tripId) return
    dirtyRef.current = false
    try {
      await tripsApi.savePackingList(tripId, latestRef.current)
      setSaveError(false)
    } catch (err) {
      console.error('[PackingListPage] save failed:', err)
      dirtyRef.current = true
      setSaveError(true)
    }
  }

  function scheduleSave() {
    dirtyRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void persist(), SAVE_DEBOUNCE_MS)
  }

  // Flush a pending save when the user navigates away inside the SPA.
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (dirtyRef.current) void persist()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!tripId) return
    tripsApi.get(tripId).then(res => {
      setTripName(res.data.name ?? '')
      const start = res.data.startDate ? formatTripDate(res.data.startDate, 'MMM d') : ''
      const end = res.data.endDate ? formatTripDate(res.data.endDate, 'MMM d, yyyy') : ''
      setDateRange(start && end ? `${start} – ${end}` : start || end)
      if (res.data.packingList) setCategories(res.data.packingList)
      setLoading(false)
    })
  }, [tripId])

  // Reset window scroll to the top on the loading→ready edge when the tall
  // category checklist first mounts. See hooks/useScrollResetOnReady.
  useScrollResetOnReady(!loading)

  async function generate() {
    if (!tripId) return
    setGenerating(true)
    try {
      // Server-side carry-over keeps already-packed items checked when the
      // regenerated list contains a same-named item.
      const res = await tripsApi.generatePackingList(tripId)
      setCategories(res.data)
    } catch (err: any) {
      // FEATURE_GATED 403 → paywall opened by the central axios interceptor
      // (services/api.ts). This endpoint can 403 with feature
      // 'packingListGenerator' (more specific gate, checked first) OR
      // 'aiPlannerUnlimited' (umbrella). Non-paywall failures keep the prior
      // silent posture.
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
        return
      }
      console.error('[PackingListPage] generate failed:', err)
    } finally {
      setGenerating(false)
    }
  }

  async function exportPdf(mode: 'blank' | 'current') {
    if (!tripId || categories.length === 0) return
    setExporting(true)
    try {
      // Pro gate — same rule as the trip PDF's pdfExport feature. The server
      // endpoint 403s FEATURE_GATED for free users (paywall opens via the
      // central interceptor). To ungate later, delete this one call.
      await tripsApi.exportPdf(tripId)

      // Dynamic import so the ~1.5MB @react-pdf/renderer chunk only loads on click.
      const [{ pdf }, { PackingListPDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('../components/pdf/PackingListPDF'),
      ])
      const blob = await pdf(
        <PackingListPDF tripName={tripName} dateRange={dateRange} categories={categories} mode={mode} />
      ).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `RoamReady-${(tripName || 'Trip').replace(/[^a-zA-Z0-9]+/g, '-')}-Packing-List-${mode}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err: any) {
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
        return
      }
      console.error('[PackingListPage] PDF export failed:', err)
      alert('PDF export failed. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  function toggleItem(catIdx: number, itemIdx: number) {
    setCategories(prev => prev.map((cat, ci) =>
      ci === catIdx ? {
        ...cat,
        items: cat.items.map((item, ii) => ii === itemIdx ? { ...item, checked: !item.checked } : item)
      } : cat
    ))
    scheduleSave()
  }

  // Curation: × removes the item from the list entirely ("not on my list" —
  // distinct from the checkbox's "packed"). A category emptied by removals
  // disappears with its last item.
  function removeItem(catIdx: number, itemIdx: number) {
    setCategories(prev => prev
      .map((cat, ci) => ci === catIdx
        ? { ...cat, items: cat.items.filter((_, ii) => ii !== itemIdx) }
        : cat)
      .filter(cat => cat.items.length > 0)
    )
    scheduleSave()
  }

  // Add a user item to a category. Always custom: true so it survives Regenerate
  // (mergePackedState appends custom items) and shows the "added" cue.
  function addItem(catIdx: number) {
    const name = (addText[catIdx] ?? '').trim()
    if (!name) return
    setCategories(prev => prev.map((cat, ci) => ci === catIdx
      ? { ...cat, items: [...cat.items, { name, required: false, checked: false, custom: true }] }
      : cat))
    setAddText(prev => ({ ...prev, [catIdx]: '' }))
    scheduleSave()
  }

  function startRename(catIdx: number, itemIdx: number, current: string) {
    setEditing({ ci: catIdx, ii: itemIdx })
    setEditText(current)
  }

  // Commit an inline rename. A rename promotes the item to custom: true — the
  // user has made it theirs, and the regenerate merge matches by NAME, so a
  // renamed AI item would otherwise be dropped on Rebuild. Empty input cancels.
  function commitRename() {
    if (!editing) return
    const name = editText.trim()
    const { ci, ii } = editing
    setEditing(null)
    if (!name) return
    setCategories(prev => prev.map((cat, c) => c === ci
      ? { ...cat, items: cat.items.map((item, i) => i === ii ? { ...item, name, custom: true } : item) }
      : cat))
    scheduleSave()
  }

  const totalItems = categories.reduce((sum, cat) => sum + cat.items.length, 0)
  const checkedItems = categories.reduce((sum, cat) => sum + cat.items.filter(i => i.checked).length, 0)
  const progress = totalItems > 0 ? Math.round((checkedItems / totalItems) * 100) : 0

  if (loading) return <div className="flex justify-center py-20"><div className="w-6 h-6 border-2 border-[#1F6F8B] border-t-transparent rounded-full animate-spin" /></div>

  return (
    <div className="space-y-4 max-w-2xl">
      <Breadcrumb items={[
        { label: 'Dashboard', href: '/dashboard' },
        { label: tripName || 'Trip', href: `/trips/${tripId}/map` },
        { label: 'Packing List' },
      ]} />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-gray-900">Packing List</h1>
        {/* One action, one button, per state: with a list, the header owns
            Regenerate (confirm-gated) + Export; with no list, the empty-state
            card below owns the only Generate button. */}
        {categories.length > 0 && (
          <div className="flex gap-2">
            {/* Export PDF ▾ — choose blank (pen-and-paper) or a current-state
                snapshot at print time. Menu closes on select or outside click. */}
            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => setExportMenuOpen(o => !o)}
                disabled={exporting}
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                className="btn-outline text-sm flex items-center gap-1.5"
              >
                {exporting ? <Loader size={14} className="animate-spin" /> : <FileDown size={14} />}
                {exporting ? 'Exporting...' : 'Export PDF'}
                {!exporting && <ChevronDown size={14} className="-mr-0.5" />}
              </button>
              {exportMenuOpen && !exporting && (
                <div role="menu" className="absolute right-0 mt-1 w-60 bg-white border border-gray-200 rounded-md shadow-lg z-10 py-1">
                  <button
                    role="menuitem"
                    onClick={() => { setExportMenuOpen(false); void exportPdf('current') }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 flex flex-col"
                  >
                    <span className="text-sm text-gray-800">Current state</span>
                    <span className="text-xs text-gray-500">Packed items ticked, includes added items</span>
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setExportMenuOpen(false); void exportPdf('blank') }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 flex flex-col"
                  >
                    <span className="text-sm text-gray-800">Blank checklist</span>
                    <span className="text-xs text-gray-500">Empty boxes for pen and paper</span>
                  </button>
                </div>
              )}
            </div>
            <button onClick={() => setShowRegenConfirm(true)} disabled={generating} className="btn-outline text-sm flex items-center gap-1.5">
              {generating ? <Loader size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {generating ? 'Generating...' : 'Regenerate with AI'}
            </button>
          </div>
        )}
      </div>

      {saveError && (
        <div className="card bg-red-50 border-red-200 flex items-center justify-between gap-3">
          <p className="text-sm text-red-700">Couldn't save your changes — they'll be lost if you leave this page.</p>
          <button
            onClick={() => { if (saveTimer.current) clearTimeout(saveTimer.current); void persist() }}
            className="text-sm font-medium text-red-700 underline flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {categories.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-600">{checkedItems} of {totalItems} packed</span>
            <span className="text-sm font-medium text-[#1F6F8B]">{progress}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-[#1F6F8B] rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={showRegenConfirm}
        title="Rebuild suggestions with AI?"
        message={
          <>
            <p className="mb-3">
              This refreshes the AI's suggestions for your current travel party and trip — useful if you've added people, pets, or stops since this list was made.
            </p>
            <ul className="space-y-1.5">
              <li className="flex items-start gap-2">
                <Check size={14} className="text-[#1F6F8B] mt-0.5 flex-shrink-0" />
                <span>Your checked-off items and your own added items are kept</span>
              </li>
              <li className="flex items-start gap-2">
                <Undo2 size={14} className="text-gray-400 mt-0.5 flex-shrink-0" />
                <span>AI items you removed may come back</span>
              </li>
            </ul>
          </>
        }
        confirmLabel="Rebuild list"
        onConfirm={() => { setShowRegenConfirm(false); void generate() }}
        onCancel={() => setShowRegenConfirm(false)}
      />

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
                  <div key={ii} className="flex items-center gap-3 group">
                    <div
                      className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors ${
                        item.checked ? 'bg-[#1F6F8B] border-[#1F6F8B]' : 'border-gray-300 group-hover:border-[#1F6F8B]'
                      }`} style={{ borderWidth: '0.5px' }}
                      onClick={() => toggleItem(ci, ii)}
                    >
                      {item.checked && <Check size={12} className="text-white" />}
                    </div>
                    {editing && editing.ci === ci && editing.ii === ii ? (
                      <input
                        type="text"
                        autoFocus
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        onFocus={e => e.target.select()}
                        onKeyDown={e => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          else if (e.key === 'Escape') { escapeRename.current = true; e.currentTarget.blur() }
                        }}
                        onBlur={() => {
                          // Escape sets the guard so this programmatic blur cancels
                          // instead of saving; Enter and click-away fall through to save.
                          if (escapeRename.current) { escapeRename.current = false; setEditing(null); return }
                          commitRename()
                        }}
                        aria-label={`Rename ${item.name}`}
                        className="flex-1 text-sm border border-gray-200 rounded px-2 py-0.5 focus:outline-none focus:border-[#1F6F8B] bg-white"
                      />
                    ) : (
                      <>
                        <span
                          className={`text-sm cursor-pointer transition-colors ${item.checked ? 'line-through text-gray-400' : 'text-gray-700'}`}
                          onClick={() => toggleItem(ci, ii)}
                        >
                          {item.name}
                          {item.required && <span className="text-red-400 ml-1">*</span>}
                          {item.custom && <span className="text-gray-400 text-xs ml-2">added</span>}
                        </span>
                        <div className="ml-auto flex items-center flex-shrink-0">
                          <button
                            type="button"
                            onClick={() => startRename(ci, ii, item.name)}
                            aria-label={`Rename ${item.name}`}
                            title="Rename"
                            className="p-1 text-gray-300 hover:text-[#1F6F8B] opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeItem(ci, ii)}
                            aria-label={`Remove ${item.name}`}
                            title="Remove from list"
                            className="p-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
                {/* Per-category add. Adds a custom item; persistence rides the
                    same debounced scheduleSave as toggle/remove. */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    value={addText[ci] ?? ''}
                    onChange={e => setAddText(prev => ({ ...prev, [ci]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') addItem(ci) }}
                    placeholder="Add item…"
                    className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-[#1F6F8B] bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => addItem(ci)}
                    disabled={!(addText[ci] ?? '').trim()}
                    className="flex items-center gap-1 text-sm text-[#1F6F8B] hover:text-[#175866] disabled:opacity-40 flex-shrink-0"
                  >
                    <Plus size={14} /> Add
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
