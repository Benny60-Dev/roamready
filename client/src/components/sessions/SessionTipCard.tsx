import { useEffect, useState } from 'react'
import { Sparkles, Zap, Compass, Heart, type LucideIcon } from 'lucide-react'

const STORAGE_KEY = 'roamready:lastTipIndex'

type Kind = 'try' | 'capability' | 'knowledge' | 'brand'

const TIPS: ReadonlyArray<{ kind: Kind; text: string }> = [
  { kind: 'try', text: 'Try this: "Plan a long weekend somewhere I can swim with my dog."' },
  { kind: 'try', text: 'Try this: "Find me a 4-night trip with no rough roads and full hookups."' },
  { kind: 'try', text: 'Try this: "I want to see the stars — pick a dark-sky destination."' },
  { kind: 'capability', text: 'Roamready knows your rig — we route around low bridges and tight switchbacks automatically.' },
  { kind: 'knowledge', text: 'Heads up: most national park campgrounds book 6 months out. Ask me about timing.' },
  { kind: 'knowledge', text: "Boondocking? Tell me your solar setup and I'll find sites without hookups." },
  { kind: 'knowledge', text: 'Tip: rest stops and Walmarts vary by state — ask before relying on them for overnights.' },
  { kind: 'brand', text: 'Built by RVers, for RVers. If something feels off, hit the feedback button — I read every one.' },
  { kind: 'brand', text: 'Roamready is not a booking site — we point you to the real reservation pages and you book direct.' },
  { kind: 'capability', text: 'Travel with kids? Tell me their ages and I will bias toward parks with playgrounds and kid-friendly trails.' },
]

const KIND_STYLES: Record<Kind, { borderColor: string; iconBg: string; iconStroke: string }> = {
  try: {
    borderColor: '#F7A829', // Sunset Gold
    iconBg: '#FAEEDA',
    iconStroke: '#854F0B',
  },
  capability: {
    borderColor: '#1F6F8B', // RV Blue
    iconBg: '#E6F1FB',
    iconStroke: '#0C447C',
  },
  knowledge: {
    borderColor: '#3E5540', // Pine
    iconBg: '#DCE5D5',
    iconStroke: '#2F4030',
  },
  brand: {
    borderColor: '#8458B4', // D1 Purple (mid-stop of sunset gradient)
    iconBg: '#EEEDFE',
    iconStroke: '#3C3489',
  },
}

const ICON_MAP: Record<Kind, LucideIcon> = {
  try: Sparkles,
  capability: Zap,
  knowledge: Compass,
  brand: Heart,
}

function readLastIndex(): number | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const n = parseInt(raw, 10)
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

function writeLastIndex(i: number) {
  try {
    sessionStorage.setItem(STORAGE_KEY, String(i))
  } catch {
    /* ignore — private-browsing or storage disabled */
  }
}

function pickTipIndex(): number {
  if (TIPS.length === 0) return -1
  if (TIPS.length === 1) return 0
  const last = readLastIndex()
  const candidates: number[] = []
  for (let i = 0; i < TIPS.length; i++) {
    if (i !== last) candidates.push(i)
  }
  const chosen = candidates[Math.floor(Math.random() * candidates.length)]
  writeLastIndex(chosen)
  return chosen
}

export default function SessionTipCard() {
  const [index, setIndex] = useState<number | null>(null)

  // Pick once on mount; do not re-pick on re-renders (autosave triggers many).
  useEffect(() => {
    setIndex(pickTipIndex())
  }, [])

  if (TIPS.length === 0) return null
  if (index === null) return null

  const tip = TIPS[index]
  const styles = KIND_STYLES[tip.kind]
  const Icon = ICON_MAP[tip.kind]

  return (
    <div
      className="mx-auto bg-white"
      style={{
        maxWidth: 600,
        width: '100%',
        display: 'flex',
        borderTop: '0.5px solid #E8E4DA',
        borderRight: '0.5px solid #E8E4DA',
        borderBottom: '0.5px solid #E8E4DA',
        borderLeft: `3px solid ${styles.borderColor}`,
        borderRadius: '0 8px 8px 0',
        padding: '14px 16px',
        marginBottom: 24,
      }}
    >
      <div className="flex items-center" style={{ gap: 12, width: '100%' }}>
        <span
          className="flex-shrink-0 flex items-center justify-center"
          aria-hidden="true"
          style={{
            width: 32,
            height: 32,
            borderRadius: 999,
            backgroundColor: styles.iconBg,
          }}
        >
          <Icon size={16} strokeWidth={2} color={styles.iconStroke} aria-hidden="true" />
        </span>
        <p
          className="m-0"
          style={{ fontSize: 14, lineHeight: 1.5, color: '#2C2C2A' }}
        >
          {tip.text}
        </p>
      </div>
    </div>
  )
}
