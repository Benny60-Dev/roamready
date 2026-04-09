import { MessageSquare } from 'lucide-react'

interface Props {
  onClick: () => void
}

export default function FeedbackButton({ onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className="fixed bottom-20 md:bottom-6 right-4 z-30 flex items-center gap-2 bg-[#1D9E75] text-white px-3 py-2 rounded-lg text-sm font-medium shadow-sm hover:bg-[#085041] transition-colors"
    >
      <MessageSquare size={15} />
      <span className="hidden sm:block">Feedback</span>
    </button>
  )
}
