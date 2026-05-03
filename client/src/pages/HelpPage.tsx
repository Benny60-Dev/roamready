import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

const FAQ: { q: string; a: string }[] = [
  {
    q: 'How do I edit my rig?',
    a: 'Head to Profile → Rigs and tap the rig you want to edit. You can update dimensions, hookup type, fuel info, and notes. Changes save automatically.',
  },
  {
    q: 'How does the AI plan trips?',
    a: "Tell me where you want to go (or ask for a surprise), and I'll build a route that respects your rig dimensions, hookup needs, and travel style. Everything is editable — if you don't like a stop, just say so in the chat and I'll redo it.",
  },
  {
    q: 'Why doesn\'t "Reserve" actually book my campsite?',
    a: "I'm honest about this — RoamReady doesn't book campgrounds for you yet. When you click a campground, I open the real reservation page in a new tab so you can book direct. Then come back and log your confirmation number so the trip stays organized. A full booking integration is coming, but I'd rather be upfront now than promise something I can't deliver.",
  },
  {
    q: 'How do I share a trip with someone?',
    a: "Open any trip and tap the Share button. You'll get a public link that shows the itinerary without exposing your private notes, packing list, or confirmation numbers. Share it however you want — text, email, group chat. The link works without an account.",
  },
  {
    q: 'I found a bug or have a feature request — what should I do?',
    a: "Email me at dev@roamready.ai. Bug reports and feature requests are equally welcome — I genuinely want to know what's not working or what's missing. RoamReady gets better because of feedback like yours.",
  },
]

export default function HelpPage() {
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  return (
    <div className="max-w-[720px] mx-auto py-2 space-y-6">
      {/* Title + intro */}
      <div>
        <h1 className="text-2xl font-medium text-gray-900 mb-2">Help &amp; Support</h1>
        <p className="text-sm text-gray-700 leading-relaxed">
          Hey, I&apos;m Benny — fellow RVer who built RoamReady. If something&apos;s broken, confusing,
          or missing, I want to hear about it. This page covers the most common questions and
          known issues. Anything not here, email me directly.
        </p>
      </div>

      {/* Contact card */}
      <section
        className="bg-white"
        style={{ border: '0.5px solid #E8E4DA', borderRadius: 8, padding: 24 }}
      >
        <h2 className="text-base font-medium text-gray-900 mb-2">Get in touch</h2>
        <p className="text-sm text-gray-700">
          Email me at{' '}
          <a
            href="mailto:dev@roamready.ai"
            className="text-[#1F6F8B] hover:underline font-medium"
          >
            dev@roamready.ai
          </a>
        </p>
        <p className="text-xs italic text-gray-500 mt-2">
          I read every email — usually reply within a day.
        </p>
      </section>

      {/* FAQ */}
      <section
        className="bg-white"
        style={{ border: '0.5px solid #E8E4DA', borderRadius: 8, padding: 24 }}
      >
        <h2 className="text-base font-medium text-gray-900 mb-4">Frequently asked questions</h2>
        <ul className="divide-y" style={{ borderColor: '#E8E4DA' }}>
          {FAQ.map((item, i) => {
            const isOpen = openIdx === i
            return (
              <li key={i} style={i === 0 ? { borderTopWidth: 0 } : { borderTopWidth: '0.5px', borderColor: '#E8E4DA' }}>
                <button
                  type="button"
                  onClick={() => setOpenIdx(isOpen ? null : i)}
                  aria-expanded={isOpen}
                  className="w-full flex items-center justify-between gap-3 py-3 text-left hover:opacity-80 transition-opacity"
                >
                  <span className="text-[15px] font-medium text-gray-900">{item.q}</span>
                  {isOpen
                    ? <ChevronUp size={16} className="text-gray-500 flex-shrink-0" />
                    : <ChevronDown size={16} className="text-gray-500 flex-shrink-0" />}
                </button>
                {isOpen && (
                  <div
                    className="text-sm text-gray-700 leading-relaxed mb-3 px-4 py-3 rounded-lg"
                    style={{ backgroundColor: '#F5F4F2' }}
                  >
                    {item.a}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {/* Known issues */}
      <section
        className="bg-white"
        style={{ border: '0.5px solid #E8E4DA', borderRadius: 8, padding: 24 }}
      >
        <h2 className="text-base font-medium text-gray-900 mb-3">Known issues</h2>
        <p className="text-sm text-gray-700 mb-3">A few things I&apos;m aware of and working on:</p>
        <ul className="text-sm text-gray-700 leading-relaxed space-y-2 list-disc pl-5">
          <li>
            On iPhone Safari, the page sometimes renders too zoomed-in after login or after
            tapping the trip planner. Workaround: pinch to zoom out and it&apos;ll snap back to
            normal. Real fix in the works.
          </li>
        </ul>
        <p className="text-xs italic text-gray-500 mt-4">
          Found something else? Email me — I read every one.
        </p>
      </section>

      {/* Footer */}
      <p className="text-xs italic text-gray-400 text-center">Last updated: May 2026</p>
    </div>
  )
}
