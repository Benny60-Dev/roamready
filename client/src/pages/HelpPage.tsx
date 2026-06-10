// Help / FAQ page. Public route (logged-out evaluators can read it).
//
// VOICE RULE: this page reads in first-person PLURAL ("we / us / our")
// throughout — RoamReady has multiple owners and the page is written
// from the team's perspective. User-perspective "I" in FAQ question
// titles ("Why do I need to ...") is correct usage — that's the
// asker, not the team. The booking FAQ was the last singular-voice
// holdout from the Reservation Honesty cleanup; converted to "we"
// + retitled in the same pass.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronUp, MessageSquare } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { useUIStore } from '../store/uiStore'

const FAQ: { q: string; a: string }[] = [
  {
    q: 'How do I edit my rig?',
    a: 'Head to Profile → Rigs and tap the rig you want to edit. You can update dimensions, hookup type, fuel info, and notes. Changes save automatically.',
  },
  {
    q: 'How does the AI plan trips?',
    // Voice sweep: was "Tell me ... I'll build ... I'll redo it" — the
    // first-person there referred to the AI assistant, but on a page
    // written by the team we reframe to neutral/object so no "I" leaks.
    a: "Tell the planner where you want to go (or ask for a surprise), and it'll build a route that respects your rig dimensions, hookup needs, and travel style. Everything is editable — if you don't like a stop, just say so in the chat and the AI will redo it.",
  },
  {
    q: 'How does booking work?',
    // Rewritten + voice-swept to "we". Title also retitled away from
    // the stale "Reserve" reference — the UI button has said
    // "Book at {name}" for a while now; the FAQ entry pointer should
    // match. Content is the honest description: open external URL,
    // record the confirmation # back here.
    a: "RoamReady doesn't book campgrounds for you yet — we open the real reservation page in a new tab so you can book direct. When you're done, come back and record your confirmation number so the trip stays organized. A full booking integration is on the roadmap, but we'd rather be upfront now than promise something we can't deliver.",
  },
  {
    q: 'How do I share a trip with someone?',
    a: "Open any trip and tap the Share button. You'll get a public link that shows the itinerary without exposing your private notes, packing list, or confirmation numbers. Share it however you want — text, email, group chat. The link works without an account.",
  },
  {
    q: 'Why do I need to verify my email?',
    a: 'Verification protects your trips from being lost if you mistype your address at signup. You get an hour to use the app before verification is required. Click the link in the email we sent — it never expires.',
  },
  {
    q: 'Can I use RoamReady offline?',
    a: "Not yet — we're web-only for now. A mobile app with offline support is on the roadmap once we have a steady userbase.",
  },
  {
    q: 'I found a bug or have a feature request — what should I do?',
    // Voice sweep: was "Email me ... I genuinely want ..."
    a: "Email us at support@roamready.ai. Bug reports and feature requests are equally welcome — we genuinely want to know what's not working or what's missing. RoamReady gets better because of feedback like yours.",
  },
]

export default function HelpPage() {
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const isAuthenticated = useAuthStore(s => s.isAuthenticated())
  const openFeedbackModal = useUIStore(s => s.openFeedbackModal)

  return (
    <div className="min-h-screen bg-rr-bg">
      {/* Masthead — "← Home" (authed) then the centered icon + wordmark, both
          ABOVE the gradient divider so they read as a header band, mirroring
          AppLayout's header → strip order. */}
      {isAuthenticated && (
        <div className="max-w-[720px] mx-auto px-4 pt-4">
          <Link to="/dashboard" className="text-sm text-[#1F6F8B] hover:underline">
            ← Home
          </Link>
        </div>
      )}
      <div className="max-w-[720px] mx-auto px-4 pt-4 pb-5 text-center">
        <Link to="/" className="inline-flex items-center gap-2">
          <img src="/roamready-icon.png" alt="RoamReady" className="h-7 w-auto object-contain" />
          <span className="font-medium text-xl">
            <span style={{ color: '#1F6F8B' }}>Roam</span><span style={{ color: '#F7A829' }}>Ready</span><span style={{ color: '#1F6F8B' }}>.ai</span>
          </span>
        </Link>
      </div>

      {/* Sunset-gradient divider — now sits BELOW the masthead (Home + wordmark),
          the same 4px hairline AppLayout uses under its header. */}
      <div className="h-1 w-full" style={{ background: 'var(--rr-sunset-gradient)' }} />

      <div className="max-w-[720px] mx-auto px-4 pt-8 pb-6 text-center">
        <h1 className="text-3xl sm:text-4xl font-medium text-gray-900">Help &amp; Support</h1>
      </div>

      <div className="max-w-[720px] mx-auto px-4 pb-12 space-y-6">
        {/* Contact card */}
        <section className="card-lg">
          <p className="text-sm text-gray-700 leading-relaxed mb-3">
            We started RoamReady because trip planning for RV trips is harder than it should be —
            and as RVers ourselves, we wanted something better. We're a small team. We use the
            product. We read every message. Got a question, found a bug, or just want to say hi?
            Reach out anytime.
          </p>
          <p className="text-sm text-gray-700">
            Email us at{' '}
            <a
              href="mailto:support@roamready.ai"
              className="text-[#1F6F8B] hover:underline font-medium"
            >
              support@roamready.ai
            </a>
          </p>
        </section>

        {/* FAQ */}
        <section className="card-lg">
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

        {/* Product Roadmap — public feedback/voting board. Moved here from the
            Resources "Tools & guides" hub; Help is the natural home for "what's
            coming + submit feedback". The /roadmap page stays public + unchanged. */}
        <section className="card-lg">
          <h2 className="text-base font-medium text-gray-900 mb-2">Product Roadmap</h2>
          <p className="text-sm text-gray-700 mb-3">
            See what we&apos;re building next, what&apos;s already shipped, and vote on the
            features that matter most to you.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <Link
              to="/roadmap"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[#1F6F8B] hover:underline"
            >
              View the Product Roadmap →
            </Link>
            {/* Same feedback modal RoadmapPage opens (useUIStore.openFeedbackModal;
                FeedbackModal is mounted app-wide in App.tsx, so it works on this
                standalone route too). Styled btn-outline, not a gold CTA. */}
            <button
              type="button"
              onClick={openFeedbackModal}
              className="btn-outline text-sm inline-flex items-center gap-1.5"
            >
              <MessageSquare size={14} /> Submit feedback
            </button>
          </div>
        </section>

        {/* Known issues */}
        <section className="card-lg">
          <h2 className="text-base font-medium text-gray-900 mb-3">Known issues</h2>
          <p className="text-sm text-gray-700 leading-relaxed">
            No known issues right now — everything&apos;s running smoothly. Spot something? Email us
            and we&apos;ll jump on it.
          </p>
        </section>

        {/* Footer */}
        <p className="text-xs italic text-gray-400 text-center">
          RoamReady · Built by RVers, for RVers · Mesa, AZ
        </p>
      </div>
    </div>
  )
}
