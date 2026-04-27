import { useEffect } from 'react'
import { X } from 'lucide-react'

interface BottomSheetProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  /** When true, prevents close-on-backdrop-tap and ESC. Used during async operations. */
  locked?: boolean
}

export default function BottomSheet({ isOpen, onClose, title, children, locked = false }: BottomSheetProps) {
  // ESC key closes (unless locked)
  useEffect(() => {
    if (!isOpen || locked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, locked, onClose])

  // Lock body scroll while sheet is open
  useEffect(() => {
    if (!isOpen) return
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = original }
  }, [isOpen])

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[80] bg-black transition-opacity duration-300 ease-out"
        style={{
          opacity: isOpen ? 0.45 : 0,
          pointerEvents: isOpen ? 'auto' : 'none',
        }}
        onClick={() => { if (!locked) onClose() }}
        aria-hidden="true"
      />

      {/* Sheet panel */}
      <div
        className="fixed left-0 right-0 bottom-0 z-[81] bg-white rounded-t-2xl shadow-2xl flex flex-col transition-transform duration-300 ease-out"
        style={{
          maxHeight: '80vh',
          transform: isOpen ? 'translateY(0)' : 'translateY(100%)',
          pointerEvents: isOpen ? 'auto' : 'none',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Bottom sheet'}
      >
        {/* Drag handle visual */}
        <div className="flex justify-center pt-2 pb-1 flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-gray-300" />
        </div>

        {/* Header (only renders if title provided) */}
        {title && (
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 flex-shrink-0" style={{ borderBottomWidth: '0.5px' }}>
            <h3 className="font-medium text-gray-900 text-base">{title}</h3>
            {!locked && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="p-1 -mr-1 text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={20} />
              </button>
            )}
          </div>
        )}

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {children}
        </div>
      </div>
    </>
  )
}
