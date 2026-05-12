// Help / FAQ page. Public route (logged-out evaluators can read it).
//
// VOICE RULE: this page reads in first-person PLURAL ("we / us / our")
// throughout — RoamReady has multiple owners and the page is written
// from the team's perspective. The one exception is the
// "Why doesn't 'Reserve' actually book my campsite?" FAQ entry, which
// intentionally retains its singular voice pending a planned booking-
// flow overhaul next session that will rewrite the answer entirely.
// User-perspective "I" in FAQ question titles ("Why do I need to ...")
// is correct usage — that's the asker, not the team.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useAuthStore } from '../store/authStore'

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
    q: 'Why doesn\'t "Reserve" actually book my campsite?',
    // INTENTIONALLY UNCHANGED voice — booking-flow overhaul is queued
    // for next session, and the answer will be rewritten end-to-end at
    // that point. Per the Phase 4 Help spec, leave the singular voice
    // in place rather than touch this paragraph twice.
    a: "I'm honest about this — RoamReady doesn't book campgrounds for you yet. When you click a campground, I open the real reservation page in a new tab so you can book direct. Then come back and log your confirmation number so the trip stays organized. A full booking integration is coming, but I'd rather be upfront now than promise something I can't deliver.",
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

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#F5F4F2' }}>
      {/* Wordmark header — matches VerifyEmailPage's standalone treatment.
          Both authed and unauthed users see this; authed users lose the
          AppLayout chrome temporarily but get a "back to dashboard" link
          below for an easy return path. */}
      <div className="pt-10 pb-6 flex flex-col items-center gap-3">
        <Link to="/" className="text-2xl">
          <span style={{ color: '#1F6F8B' }}>Roam</span>
          <span style={{ color: '#F7A829' }}>ready</span>
          <span style={{ color: '#1F6F8B' }}>.ai</span>
        </Link>
        {isAuthenticated && (
          <Link to="/dashboard" className="text-xs text-[#1F6F8B] hover:underline">
            ← Back to dashboard
          </Link>
        )}
      </div>

      <div className="max-w-[720px] mx-auto px-4 pb-12 space-y-6">
        {/* Title + intro */}
        <div>
          <h1 className="text-2xl font-medium text-gray-900 mb-2">Help &amp; Support</h1>
          <p className="text-sm text-gray-700 leading-relaxed">
            We started RoamReady because trip planning for RV trips is harder than it should be —
            and as RVers ourselves, we wanted something better. We're a small team. We use the
            product. We read every message. Got a question, found a bug, or just want to say hi?
            Reach out anytime.
          </p>
        </div>

        {/* Contact card */}
        <section
          className="bg-white"
          style={{ border: '0.5px solid #E8E4DA', borderRadius: 8, padding: 24 }}
        >
          <h2 className="text-base font-medium text-gray-900 mb-2">Get in touch</h2>
          <p className="text-sm text-gray-700">
            Email us at{' '}
            <a
              href="mailto:support@roamready.ai"
              className="text-[#1F6F8B] hover:underline font-medium"
            >
              support@roamready.ai
            </a>
          </p>
          <p className="text-xs italic text-gray-500 mt-2">
            We read every email — usually reply within a day.
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
          <p className="text-sm text-gray-700 mb-3">A few things we're aware of and working on:</p>
          <ul className="text-sm text-gray-700 leading-relaxed space-y-2 list-disc pl-5">
            <li>
              On iPhone Safari, the page sometimes renders too zoomed-in after login or after
              tapping the trip planner. Workaround: pinch to zoom out and it&apos;ll snap back to
              normal. Real fix in the works.
            </li>
            <li>
              Trip journal photo uploads are temporarily disabled while we sort out storage —
              text journal entries still work.
            </li>
          </ul>
          <p className="text-xs italic text-gray-500 mt-4">
            Found something else? Email us — we read every one.
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
