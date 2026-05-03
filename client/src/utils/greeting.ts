/**
 * Time-aware, context-aware greeting selection for the SessionPage empty state.
 * Uses sessionStorage to avoid showing the same greeting twice in a row.
 */

interface GreetingTemplate {
  key: string
  text: string // contains {firstName} placeholder
}

const FIRST_TIME: GreetingTemplate[] = [
  { key: 'first-1', text: "Welcome to RoamReady, {firstName}. Let's plan your first trip." },
  { key: 'first-2', text: "Glad you're here, {firstName}. Where do you want to go first?" },
  { key: 'first-3', text: 'Hey {firstName} — first trip is the fun one. Where to?' },
]

const RETURNING: GreetingTemplate[] = [
  { key: 'return-1', text: 'Hey {firstName} — been a while. Where are we headed?' },
  { key: 'return-2', text: 'Welcome back, {firstName} — ready for the next one?' },
  { key: 'return-3', text: 'Long time, {firstName}. Got somewhere in mind?' },
  { key: 'return-4', text: "Hey bud — glad you're back. What's the plan?" },
]

const MORNING: GreetingTemplate[] = [
  { key: 'morning-1', text: 'Good morning, {firstName} — where are we headed?' },
  { key: 'morning-2', text: "Morning, {firstName}. Coffee's brewing — let's plan something." },
  { key: 'morning-3', text: 'Hey {firstName} — fresh day, fresh trip. Where to?' },
  { key: 'morning-4', text: "Up early, {firstName}? Let's get rolling." },
]

const AFTERNOON: GreetingTemplate[] = [
  { key: 'afternoon-1', text: 'Good afternoon, {firstName} — where are we headed?' },
  { key: 'afternoon-2', text: 'Hey bud, ready to plan something good?' },
  { key: 'afternoon-3', text: "Afternoon, {firstName}. What's the next adventure?" },
  { key: 'afternoon-4', text: 'Welcome back, {firstName} — where to today?' },
]

const EVENING: GreetingTemplate[] = [
  { key: 'evening-1', text: 'Good evening, {firstName} — where are we headed?' },
  { key: 'evening-2', text: 'Evening, {firstName}. Planning tomorrow already?' },
  { key: 'evening-3', text: "Hey {firstName} — winding down? Let's dream up a trip." },
  { key: 'evening-4', text: 'Welcome back. Got somewhere in mind?' },
]

const LATE_NIGHT: GreetingTemplate[] = [
  { key: 'late-1', text: 'Up late, {firstName}? Where are we headed?' },
  { key: 'late-2', text: "Burning the midnight oil, {firstName}? Let's plan." },
  { key: 'late-3', text: 'Hey bud — late-night trip planning is the best kind.' },
  { key: 'late-4', text: "Can't sleep, {firstName}? Let's give you something to dream about." },
]

const STORAGE_KEY = 'roamready:lastGreetingKey'

function timePool(hour: number): GreetingTemplate[] {
  if (hour >= 5 && hour <= 11) return MORNING
  if (hour >= 12 && hour <= 17) return AFTERNOON
  if (hour >= 18 && hour <= 20) return EVENING
  return LATE_NIGHT // [21,23] or [0,4]
}

// Drop the {firstName} placeholder cleanly when we don't have a name.
// Strips a leading-comma or leading-space variant so grammar stays intact:
//   "Good morning, {firstName} — ..." → "Good morning — ..."
//   "Hey {firstName} — ..."           → "Hey — ..."
//   "Welcome to RoamReady, {firstName}. ..." → "Welcome to RoamReady. ..."
function applyName(template: string, firstName: string | null | undefined): string {
  const name = firstName?.trim()
  if (name) return template.replace(/\{firstName\}/g, name)
  return template
    .replace(/, \{firstName\}/g, '')
    .replace(/ \{firstName\}/g, '')
    .replace(/\{firstName\}/g, '')
}

function readLastKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeLastKey(key: string) {
  try {
    sessionStorage.setItem(STORAGE_KEY, key)
  } catch {
    /* ignore — private-browsing or storage disabled */
  }
}

export interface SelectGreetingArgs {
  firstName: string | null | undefined
  hasAnyPriorSessions: boolean
  daysSinceLastSession: number | null
  currentDate: Date
}

export function selectGreeting(args: SelectGreetingArgs): { greeting: string; key: string } {
  let pool: GreetingTemplate[]
  if (!args.hasAnyPriorSessions) {
    pool = FIRST_TIME
  } else if (args.daysSinceLastSession !== null && args.daysSinceLastSession > 14) {
    pool = RETURNING
  } else {
    pool = timePool(args.currentDate.getHours())
  }

  const lastKey = readLastKey()
  const candidates = pool.length > 1 ? pool.filter(t => t.key !== lastKey) : pool
  const chosen = candidates[Math.floor(Math.random() * candidates.length)]
  writeLastKey(chosen.key)

  return {
    greeting: applyName(chosen.text, args.firstName),
    key: chosen.key,
  }
}
