import { useEffect, useRef } from 'react'

export interface ConfirmModalProps {
  isOpen: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
  isConfirming?: boolean
}

export default function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  danger = false,
  isConfirming = false,
}: ConfirmModalProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return
    cancelButtonRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isConfirming) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, isConfirming, onCancel])

  if (!isOpen) return null

  const handleBackdropClick = () => {
    if (!isConfirming) onCancel()
  }

  const confirmClasses = danger
    ? 'bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
    : 'bg-[#3E5540] text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-[#2F4030] transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-lg border border-gray-200 w-full max-w-[400px] p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="font-semibold text-lg text-gray-900 mb-2">{title}</h2>
        <p className="text-sm text-gray-600 mb-6 leading-relaxed">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelButtonRef}
            onClick={onCancel}
            disabled={isConfirming}
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={isConfirming}
            className={confirmClasses}
          >
            {isConfirming ? `${confirmLabel}...` : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
