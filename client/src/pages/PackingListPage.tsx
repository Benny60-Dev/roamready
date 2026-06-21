import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Wand2, Check, Loader, X, FileDown, Undo2, Plus, Pencil, ChevronDown, Bookmark, Copy, ChevronRight } from 'lucide-react'
import { tripsApi, packingTemplatesApi, PackingTemplateSummary } from '../services/api'
import { PackingCategory, PackingContext, PackingCounts } from '../types'
import { useAuthStore } from '../store/authStore'
import { useUIStore } from '../store/uiStore'
import { Breadcrumb } from '../components/ui/Breadcrumb'
import ConfirmModal from '../components/ui/ConfirmModal'
import { useScrollResetOnReady } from '../hooks/useScrollResetOnReady'
import { formatTripDate } from '../utils/dates'

const SAVE_DEBOUNCE_MS = 500
// After this long still generating, the progress notice flips to its
// "hang tight" second stage so a long AI authoring wait feels acknowledged.
const BUILD_STAGE2_MS = 8000

function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : plural ?? `${singular}s`}`
}

// "1 dog" / "2 cats" when one known type; otherwise "N pets". null when no pets.
function petsDesc(petTypes: string[] | undefined, count: number): string | null {
  if (count === 0) return null
  const distinct = Array.from(new Set(petTypes ?? []))
  if (distinct.length === 1 && (distinct[0] === 'DOG' || distinct[0] === 'CAT')) {
    return pluralize(count, distinct[0] === 'DOG' ? 'dog' : 'cat')
  }
  return pluralize(count, 'pet')
}

// "2 adults · 1 dog · 6 nights". Children only when > 0; nights optional.
function formatPackingShape(c: PackingCounts, opts?: { nights?: boolean }): string {
  const parts = [pluralize(c.adults, 'adult')]
  if (c.children > 0) parts.push(pluralize(c.children, 'child', 'children'))
  const pets = petsDesc(c.petTypes, c.pets)
  if (pets) parts.push(pets)
  if (opts?.nights !== false) parts.push(pluralize(c.nights, 'night'))
  return parts.join(' · ')
}

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
  // Staleness: server-computed context (snapshot + current counts + stale flag).
  // dismissedSnapshot holds the snapshot generatedAt the user dismissed, so the
  // banner stays hidden for THAT snapshot but re-shows when a newer one arrives.
  const [packingContext, setPackingContext] = useState<PackingContext | null>(null)
  const [dismissedSnapshot, setDismissedSnapshot] = useState<string | null>(null)
  // Two-stage progress notice during the ~10-15s AI authoring. Stage 1 is the
  // "no small job" line; stage 2 ("hang tight") flips in after BUILD_STAGE2_MS
  // if still generating. New top-section hook (above the loading early return).
  const [buildStage, setBuildStage] = useState<1 | 2>(1)

  // FR-SAVED-PACKING — save-as-template + the "how do you want to start?" chooser.
  // All hooks live in this unconditional top section (above the loading early
  // return) per the Rules of Hooks.
  const hasAccess = useAuthStore(s => s.hasAccess)
  const openPaywall = useUIStore(s => s.openPaywall)
  const isPro = hasAccess('packingListGenerator')
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [includeChecked, setIncludeChecked] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [templateSavedMsg, setTemplateSavedMsg] = useState<string | null>(null)
  // Chooser sources, lazily loaded only while the empty state is showing.
  // null = not loaded yet; [] = loaded, none available.
  const [templates, setTemplates] = useState<PackingTemplateSummary[] | null>(null)
  const [copyTrips, setCopyTrips] = useState<{ id: string; name: string }[] | null>(null)
  const [seeding, setSeeding] = useState(false)

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
  // Timer that flips the progress notice to stage 2; cleared on completion and
  // on unmount so it never fires after generation ends or the page is gone.
  const buildStageTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  // Flush a pending save when the user navigates away inside the SPA, and clear
  // the build-stage timer so it can't fire on an unmounted component.
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (buildStageTimer.current) clearTimeout(buildStageTimer.current)
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
      setPackingContext(res.data.packingContext ?? null)
      setLoading(false)
    })
  }, [tripId])

  // Load the chooser sources while the empty state is showing (no list yet).
  // Templates are fetched ONLY for Pro users — GET /packing-templates is
  // server-gated, so a non-Pro fetch would 403 and pop the paywall just from
  // viewing the page. Copy-source trips are free (filtered from getAll).
  useEffect(() => {
    if (loading || categories.length > 0 || !tripId) return
    let cancelled = false
    tripsApi.getAll()
      .then(res => {
        if (cancelled) return
        const others = (res.data as any[])
          .filter(t => t.id !== tripId && Array.isArray(t.packingList) && t.packingList.length > 0)
          .map(t => ({ id: t.id as string, name: (t.name as string) || 'Untitled trip' }))
        setCopyTrips(others)
      })
      .catch(() => { if (!cancelled) setCopyTrips([]) })
    if (isPro) {
      packingTemplatesApi.list()
        .then(res => { if (!cancelled) setTemplates(res.data) })
        .catch(() => { if (!cancelled) setTemplates([]) })
    } else {
      setTemplates([])
    }
    return () => { cancelled = true }
  }, [loading, categories.length, tripId, isPro])

  // Reset window scroll to the top on the loading→ready edge when the tall
  // category checklist first mounts. See hooks/useScrollResetOnReady.
  useScrollResetOnReady(!loading)

  async function generate() {
    if (!tripId) return
    setGenerating(true)
    // Re-stage from 1 each run; flip to stage 2 if we're still going at 8s.
    setBuildStage(1)
    if (buildStageTimer.current) clearTimeout(buildStageTimer.current)
    buildStageTimer.current = setTimeout(() => setBuildStage(2), BUILD_STAGE2_MS)
    try {
      // Server-side carry-over keeps already-packed items checked when the
      // regenerated list contains a same-named item.
      const res = await tripsApi.generatePackingList(tripId)
      setCategories(res.data)
      // Re-pull the trip so the subtitle + staleness reflect the fresh snapshot
      // (generate persists a new packingListMeta; this read returns stale=false).
      tripsApi.get(tripId).then(r => setPackingContext(r.data.packingContext ?? null)).catch(() => {})
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
      if (buildStageTimer.current) { clearTimeout(buildStageTimer.current); buildStageTimer.current = null }
      setGenerating(false)
    }
  }

  // ─── FR-SAVED-PACKING actions ────────────────────────────────────────────────

  async function saveAsTemplate() {
    if (!tripId || !templateName.trim()) return
    setSavingTemplate(true)
    try {
      // includeChecked OFF (default) → send items unchecked. The server ALSO
      // forces checked:false at store time, so the toggle is UX clarity / an
      // honest payload, not the source of truth.
      const name = templateName.trim()
      const items = includeChecked
        ? categories
        : categories.map(c => ({ ...c, items: c.items.map(i => ({ ...i, checked: false })) }))
      await packingTemplatesApi.create(name, items)
      setShowSaveTemplate(false)
      setTemplateName('')
      setIncludeChecked(false)
      setTemplateSavedMsg(`Saved “${name}” as a template`)
      setTimeout(() => setTemplateSavedMsg(null), 4000)
      // Keep the chooser's template list fresh for a later empty state.
      if (isPro) packingTemplatesApi.list().then(r => setTemplates(r.data)).catch(() => {})
    } catch (err: any) {
      // 403 FEATURE_GATED → paywall opened by the central interceptor.
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') {
        setShowSaveTemplate(false)
        return
      }
      console.error('[PackingListPage] save template failed:', err)
    } finally {
      setSavingTemplate(false)
    }
  }

  // Shared post-seed refresh: show the merged result immediately + re-pull the
  // staleness snapshot (both seed endpoints write a fresh packingListMeta).
  function applySeedResult(data: PackingCategory[]) {
    setCategories(data)
    if (tripId) tripsApi.get(tripId).then(r => setPackingContext(r.data.packingContext ?? null)).catch(() => {})
  }

  async function seedFromTemplate(templateId: string) {
    if (!tripId) return
    if (!isPro) { openPaywall('packingListGenerator'); return }
    setSeeding(true)
    try {
      const res = await tripsApi.seedPackingFromTemplate(tripId, templateId)
      applySeedResult(res.data)
    } catch (err: any) {
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') return
      console.error('[PackingListPage] seed from template failed:', err)
    } finally {
      setSeeding(false)
    }
  }

  async function copyFromTrip(sourceTripId: string) {
    if (!tripId) return
    setSeeding(true)
    try {
      const res = await tripsApi.copyPackingFromTrip(tripId, sourceTripId)
      applySeedResult(res.data)
    } catch (err: any) {
      if (err?.response?.status === 403 && err?.response?.data?.code === 'FEATURE_GATED') return
      console.error('[PackingListPage] copy from trip failed:', err)
    } finally {
      setSeeding(false)
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

  // Subtitle reflects what the list was BUILT for (the snapshot); hidden for
  // legacy lists with no snapshot. Banner shows only when server flagged drift
  // and this snapshot hasn't been dismissed this session.
  const snapshot = packingContext?.packingListMeta ?? null
  const showBanner = !!packingContext?.stale && !!snapshot && dismissedSnapshot !== snapshot.generatedAt

  // Banner copy adapts to which dimensions drifted. Nights shown in the
  // built-for/now lines only when nights actually changed (party-only changes
  // read cleaner without it).
  const banner = showBanner && snapshot && packingContext
    ? (() => {
        const { current, changed } = packingContext
        const partyChanged = changed.includes('people') || changed.includes('pets')
        const nightsChanged = changed.includes('nights')
        const lead = partyChanged && nightsChanged
          ? 'Your travel party and trip length changed'
          : partyChanged
            ? 'Your travel party changed'
            : 'Your trip length changed'
        return {
          lead,
          built: formatPackingShape(snapshot, { nights: nightsChanged }),
          now: formatPackingShape(current, { nights: nightsChanged }),
        }
      })()
    : null

  // Honest progress notice during the ~10-15s AI authoring. Stage 1 sets
  // expectations; stage 2 reassures on a long wait. Clears with `generating`.
  const buildingNotice = (
    <div className="card flex items-center gap-3">
      <Loader size={18} className="animate-spin text-[#1F6F8B] flex-shrink-0" />
      <span className="text-sm text-gray-600">
        {buildStage === 2
          ? 'Hang tight, just a few more seconds…'
          : `Packing for a trip is no small job — ${categories.length === 0 ? 'building' : 'rebuilding'} your list…`}
      </span>
    </div>
  )

  return (
    <div className="space-y-4 max-w-2xl">
      <Breadcrumb items={[
        { label: 'Dashboard', href: '/dashboard' },
        { label: tripName || 'Trip', href: `/trips/${tripId}/map` },
        { label: 'Packing List' },
      ]} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-medium text-gray-900">Packing List</h1>
          {/* "Made for X" — from the generation snapshot, so it describes what
              the list was built for. Hidden for legacy lists (no snapshot). */}
          {snapshot && (
            <p className="text-[13px] text-gray-500 mt-0.5">Made for {formatPackingShape(snapshot)}</p>
          )}
        </div>
        {/* One action, one button, per state: with a list, the header owns
            Refresh (confirm-gated) + Export; with no list, the empty-state
            card below owns the only Generate button. */}
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-2">
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
                <div role="menu" className="absolute left-0 mt-1 w-60 max-w-[calc(100vw-2rem)] bg-white border border-gray-200 rounded-md shadow-lg z-10 py-1">
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
            {/* Save the current list as a reusable template (Pro). Non-Pro
                click opens the paywall instead of the dialog. */}
            <button
              onClick={() => isPro ? setShowSaveTemplate(true) : openPaywall('packingListGenerator')}
              disabled={generating}
              title="Save this list as a reusable template"
              className="btn-outline text-sm flex items-center gap-1.5"
            >
              <Bookmark size={14} />
              Save as template
            </button>
            <button onClick={() => setShowRegenConfirm(true)} disabled={generating} className="btn-outline text-sm flex items-center gap-1.5">
              {generating ? <Loader size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {generating ? 'Generating...' : 'Refresh suggestions'}
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

      {/* Inline success confirmation after saving a template (no toast system
          in the app — mirrors the saveError card pattern, auto-clears in 4s). */}
      {templateSavedMsg && (
        <div className="card bg-green-50 border-green-200 flex items-center gap-2">
          <Check size={16} className="text-green-600 flex-shrink-0" />
          <p className="text-sm text-green-800">{templateSavedMsg}</p>
        </div>
      )}

      {banner && snapshot && (
        <div
          className="rounded-lg border p-4"
          style={{ backgroundColor: '#FDEFD9', borderColor: '#F0D9A8', borderWidth: '0.5px' }}
        >
          <p className="text-sm" style={{ color: '#8A5A0E' }}>
            {banner.lead} since this list was made — it was built for {banner.built}, but your trip
            now has {banner.now}. Refresh to update your packing list.
          </p>
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => setShowRegenConfirm(true)}
              disabled={generating}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-white flex items-center gap-1.5 disabled:opacity-50"
              style={{ backgroundColor: '#8A5A0E' }}
            >
              {generating ? <Loader size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {generating ? 'Generating...' : 'Refresh suggestions'}
            </button>
            <button
              onClick={() => setDismissedSnapshot(snapshot.generatedAt)}
              className="px-3 py-1.5 rounded-md text-sm font-medium border bg-white"
              style={{ color: '#8A5A0E', borderColor: '#F0D9A8' }}
            >
              Dismiss
            </button>
          </div>
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

      {/* Save-as-template dialog. Built inline (vs ConfirmModal) because it needs
          a name input + a checkbox; matches ConfirmModal's overlay/card styling. */}
      {showSaveTemplate && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => { if (!savingTemplate) setShowSaveTemplate(false) }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-lg border border-gray-200 w-full max-w-[400px] p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-semibold text-lg text-gray-900 mb-1">Save as template</h2>
            <p className="text-sm text-gray-600 mb-4">Reuse this list as a starting point for future trips.</p>
            <label className="block text-sm font-medium text-gray-700 mb-1">Template name</label>
            <input
              type="text"
              autoFocus
              value={templateName}
              onChange={e => setTemplateName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && templateName.trim()) void saveAsTemplate() }}
              placeholder="My Standard RV Kit"
              className="w-full text-sm border border-gray-200 rounded px-3 py-2 focus:outline-none focus:border-[#1F6F8B] bg-white mb-4"
            />
            <label className="flex items-start gap-2 mb-6 cursor-pointer">
              <input
                type="checkbox"
                checked={includeChecked}
                onChange={e => setIncludeChecked(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm text-gray-600">
                Include checked-off state
                <span className="block text-xs text-gray-400">Off by default — a template is a fresh starting point.</span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSaveTemplate(false)}
                disabled={savingTemplate}
                className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveAsTemplate()}
                disabled={savingTemplate || !templateName.trim()}
                className="bg-[#3E5540] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#2F4030] transition-colors disabled:opacity-50"
              >
                {savingTemplate ? 'Saving...' : 'Save template'}
              </button>
            </div>
          </div>
        </div>
      )}

      {categories.length === 0 ? (
        (generating || seeding) ? buildingNotice : (
          <div className="card py-8">
            <div className="text-center mb-5">
              <div className="text-4xl mb-2">🎒</div>
              <p className="font-medium text-gray-700">No packing list yet</p>
              <p className="text-sm text-gray-500">How do you want to start?</p>
            </div>
            <div className="space-y-2.5 max-w-md mx-auto">
              {/* 1 — Generate fresh with AI (existing flow) */}
              <button
                onClick={generate}
                disabled={generating || seeding}
                className="w-full text-left border border-gray-200 rounded-lg p-4 hover:border-[#1F6F8B] hover:bg-gray-50 transition-colors flex items-start gap-3 disabled:opacity-50"
              >
                <Wand2 size={18} className="text-[#1F6F8B] mt-0.5 flex-shrink-0" />
                <span className="flex-1">
                  <span className="block text-sm font-medium text-gray-800">Generate fresh with AI</span>
                  <span className="block text-xs text-gray-500">Built for this trip's party, nights &amp; rig</span>
                </span>
                <ChevronRight size={16} className="text-gray-300 mt-0.5 flex-shrink-0" />
              </button>

              {/* 2 — Start from a template (Pro) */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-4 pt-3 pb-0.5">
                  <Bookmark size={16} className="text-[#1F6F8B] flex-shrink-0" />
                  <span className="text-sm font-medium text-gray-800">Start from a template</span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[#3E5540] bg-[#EAF0EA] rounded px-1.5 py-0.5">Pro</span>
                </div>
                {!isPro ? (
                  <button
                    onClick={() => openPaywall('packingListGenerator')}
                    className="w-full text-left px-4 pb-3 pt-1 text-xs text-gray-500 hover:text-[#1F6F8B]"
                  >
                    Unlock Pro to reuse saved templates.
                  </button>
                ) : templates === null ? (
                  <div className="px-4 pb-3 pt-1 text-xs text-gray-400 flex items-center gap-1.5">
                    <Loader size={12} className="animate-spin" /> Loading templates…
                  </div>
                ) : templates.length === 0 ? (
                  <p className="px-4 pb-3 pt-1 text-xs text-gray-400">Save a list as a template first.</p>
                ) : (
                  <div className="divide-y divide-gray-100 border-t border-gray-100 mt-1">
                    {templates.map(t => (
                      <button
                        key={t.id}
                        onClick={() => seedFromTemplate(t.id)}
                        disabled={seeding}
                        className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-2 disabled:opacity-50"
                      >
                        <span className="flex-1 text-sm text-gray-700">{t.name}</span>
                        <span className="text-xs text-gray-400">{pluralize(t.itemCount, 'item')}</span>
                        <ChevronRight size={15} className="text-gray-300 flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 3 — Copy from a previous trip (Free) */}
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-4 pt-3 pb-0.5">
                  <Copy size={16} className="text-[#1F6F8B] flex-shrink-0" />
                  <span className="text-sm font-medium text-gray-800">Copy from a previous trip</span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">Free</span>
                </div>
                <p className="px-4 text-xs text-gray-500">Reuse a list you already built — merged onto this trip.</p>
                {copyTrips === null ? (
                  <div className="px-4 pb-3 pt-1 text-xs text-gray-400 flex items-center gap-1.5">
                    <Loader size={12} className="animate-spin" /> Loading trips…
                  </div>
                ) : copyTrips.length === 0 ? (
                  <p className="px-4 pb-3 pt-1 text-xs text-gray-400">No other trips with a packing list yet.</p>
                ) : (
                  <div className="divide-y divide-gray-100 border-t border-gray-100 mt-2">
                    {copyTrips.map(t => (
                      <button
                        key={t.id}
                        onClick={() => copyFromTrip(t.id)}
                        disabled={seeding}
                        className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-2 disabled:opacity-50"
                      >
                        <span className="flex-1 text-sm text-gray-700">{t.name}</span>
                        <ChevronRight size={15} className="text-gray-300 flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {generating && buildingNotice}
          {categories.map((cat, ci) => (
            <div key={ci} className="card-lg">
              <h3 className="text-[13px] font-semibold text-gray-900 mb-2">{cat.category}</h3>
              <div className="divide-y divide-gray-100">
                {cat.items.map((item, ii) => (
                  <div key={ii} className="flex items-center gap-3 group py-2.5">
                    <div
                      className={`w-5 h-5 rounded-[5px] border flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors ${
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
                          className={`text-[15px] cursor-pointer transition-colors ${item.checked ? 'line-through text-gray-400' : 'text-gray-700'}`}
                          onClick={() => toggleItem(ci, ii)}
                        >
                          {item.name}
                          {item.required && <span className="text-red-400 ml-1">*</span>}
                          {item.custom && <span className="text-[11px] text-gray-400 ml-2">added</span>}
                        </span>
                        <div className="ml-auto flex items-center flex-shrink-0">
                          <button
                            type="button"
                            onClick={() => startRename(ci, ii, item.name)}
                            aria-label={`Rename ${item.name}`}
                            title="Rename"
                            className="p-1 text-gray-300 hover:text-[#1F6F8B] opacity-40 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 transition-opacity"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeItem(ci, ii)}
                            aria-label={`Remove ${item.name}`}
                            title="Remove from list"
                            className="p-1 text-gray-300 hover:text-red-500 opacity-40 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 transition-opacity"
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
                <div className="flex items-center gap-3 pt-2.5">
                  <Plus size={18} className="text-gray-300 flex-shrink-0" />
                  <input
                    type="text"
                    value={addText[ci] ?? ''}
                    onChange={e => setAddText(prev => ({ ...prev, [ci]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') addItem(ci) }}
                    placeholder="Add item…"
                    className="flex-1 text-[15px] bg-transparent placeholder:text-gray-400 focus:outline-none"
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
