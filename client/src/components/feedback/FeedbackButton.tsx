import { MessageSquare } from 'lucide-react'

interface Props {
  onClick: () => void
}

export default function FeedbackButton({ onClick }: Props) {
  return (
    <button
      onClick={onClick}
      title="Send feedback"
      className="fixed top-1/2 -translate-y-1/2 right-0 z-30 flex flex-col items-center gap-1.5 bg-[#EA6A0A] hover:bg-[#C2580A] active:bg-[#A84D09] text-white py-3 rounded-l-lg shadow-md transition-colors"
      style={{ width: 28 }}
    >
      <MessageSquare size={13} />
      <span
        className="text-[11px] font-semibold tracking-wide leading-none"
        style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
      >
        Feedback
      </span>
    </button>
  )
}
