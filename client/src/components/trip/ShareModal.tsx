import { useEffect, useRef, useState } from 'react'
import { X, Copy, Check, RefreshCw, Link as LinkIcon } from 'lucide-react'
import { tripsApi } from '../../services/api'
import { Trip } from '../../types'
import ConfirmModal from '../ui/ConfirmModal'

interface Props {
  trip: Trip
  isOpen: boolean
  onClose: () => void
  onTripUpdated?: (sharedToken: string | null) => void
}

const D1_GRADIENT =
  'linear-gradient(90deg, #1F6F8B 0%, #8458B4 22%, #D4537E 42%, #E24B4A 60%, #F97316 80%, #F7A829 100%)'

type ConfirmAction = 'regenerate' | 'revoke' | null

export default function ShareModal({ trip, isOpen, onClose, onTripUpdated }: Props) {
  const [token, setToken] = useState<string | null>(trip.sharedToken ?? null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) setToken(trip.sharedToken ?? null)
  }, [isOpen, trip.sharedToken])

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !confirmAction) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, busy, confirmAction, onClose])

  if (!isOpen) return null

  const shareUrl = token ? `${window.location.origin}/trips/share/${token}` : ''

  async function handleCreate() {
    setBusy(true)
    try {
      const res = await tripsApi.createShare(trip.id)
      setToken(res.data.sharedToken)
      onTripUpdated?.(res.data.sharedToken)
    } finally {
      setBusy(false)
    }
  }

  async function handleCopy() {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select the input so user can copy manually
      inputRef.current?.select()
    }
  }

  async function handleRegenerate() {
    setConfirmAction(null)
    setBusy(true)
    try {
      const res = await tripsApi.regenerateShare(trip.id)
      setToken(res.data.sharedToken)
      onTripUpdated?.(res.data.sharedToken)
    } finally {
      setBusy(false)
    }
  }

  async function handleRevoke() {
    setConfirmAction(null)
    setBusy(true)
    try {
      await tripsApi.revokeShare(trip.id)
      setToken(null)
      onTripUpdated?.(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.35)' }}
        onClick={() => { if (!busy && !confirmAction) onClose() }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-modal-title"
          className="bg-white rounded-xl w-full max-w-md overflow-hidden shadow-xl"
          style={{ borderWidth: '0.5px', borderStyle: 'solid', borderColor: '#E8E4DA' }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ height: '3px', background: D1_GRADIENT }} />

          <div className="p-6">
            <div className="flex items-start justify-between mb-1">
              <h2 id="share-modal-title" className="font-medium text-gray-900 text-lg">Share this trip</h2>
              <button
                onClick={onClose}
                disabled={busy}
                aria-label="Close"
                className="p-1 -mt-1 -mr-1 rounded-lg hover:bg-gray-100 disabled:opacity-50"
              >
                <X size={18} />
              </button>
            </div>

            <p className="text-sm text-gray-500 mb-2 leading-relaxed">
              Anyone with this link can view your trip itinerary, route, and campgrounds.
            </p>
            <p className="text-xs text-gray-400 mb-5 leading-relaxed">
              Confirmation numbers, site numbers, personal notes, and your packing list are <span className="font-medium text-gray-500">not</span> shared.
            </p>

            {token ? (
              <>
                <div className="flex gap-2 mb-3">
                  <input
                    ref={inputRef}
                    readOnly
                    value={shareUrl}
                    onFocus={e => e.currentTarget.select()}
                    className="flex-1 px-3 py-2 text-sm bg-gray-50 rounded-md border border-gray-200 text-gray-700 font-mono truncate focus:outline-none focus:ring-1 focus:ring-[#1F6F8B]"
                  />
                  <button
                    onClick={handleCopy}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white rounded-md transition-opacity hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
                    style={{ background: '#1F6F8B' }}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                </div>

                <button
                  onClick={() => setConfirmAction('regenerate')}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md border transition-colors hover:bg-[#1F6F8B]/5 disabled:opacity-50"
                  style={{ borderColor: '#1F6F8B', color: '#1F6F8B' }}
                >
                  <RefreshCw size={14} />
                  Regenerate link
                </button>

                <div className="mt-6 pt-4 border-t border-gray-100">
                  <button
                    onClick={() => setConfirmAction('revoke')}
                    disabled={busy}
                    className="text-xs text-red-600 hover:text-red-700 hover:underline disabled:opacity-50"
                  >
                    Stop sharing this trip
                  </button>
                </div>
              </>
            ) : (
              <button
                onClick={handleCreate}
                disabled={busy}
                className="flex items-center justify-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-white rounded-md transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: '#1F6F8B' }}
              >
                <LinkIcon size={14} />
                {busy ? 'Creating link...' : 'Create share link'}
              </button>
            )}
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmAction === 'regenerate'}
        title="Regenerate share link?"
        message="The current link will stop working. Anyone you've already shared this trip with will need the new link."
        confirmLabel="Regenerate"
        onConfirm={handleRegenerate}
        onCancel={() => setConfirmAction(null)}
        isConfirming={busy}
      />

      <ConfirmModal
        isOpen={confirmAction === 'revoke'}
        title="Stop sharing this trip?"
        message="The share link will be revoked. Anyone with the link will no longer be able to view your trip."
        confirmLabel="Stop sharing"
        onConfirm={handleRevoke}
        onCancel={() => setConfirmAction(null)}
        danger
        isConfirming={busy}
      />
    </>
  )
}
