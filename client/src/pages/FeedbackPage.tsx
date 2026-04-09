import { useUIStore } from '../store/uiStore'
import { useEffect } from 'react'

export default function FeedbackPage() {
  const { openFeedbackModal } = useUIStore()
  useEffect(() => { openFeedbackModal() }, [])
  return <div className="flex items-center justify-center py-20 text-sm text-gray-500">Opening feedback form...</div>
}
