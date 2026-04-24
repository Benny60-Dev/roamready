import { MessageSquare } from 'lucide-react'

interface Props {
  onClick: () => void
}

export default function FeedbackButton({ onClick }: Props) {
  return (
    <button
      onClick={onClick}
      title="Send feedback"
      className="fixed top-1/2 -translate-y-1/2 right-0 z-30 flex flex-col items-center gap-1.5 bg-[#F7A829] hover:bg-[#C9851A] active:bg-[#8A5A0E] text-white py-3 rounded-l-lg shadow-md transition-colors"
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
