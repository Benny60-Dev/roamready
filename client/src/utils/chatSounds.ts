// Subtle Web Audio chat cues, synthesized in code (no audio files to host).
// Two clearly DIFFERENT tones so "message sent" vs "reply arrived" are
// distinguishable by ear:
//   - sent:  a short RISING two-note cue (C5 → G5)
//   - reply: a short FALLING two-note cue (D5 → G4), lower and a touch softer
//
// Always on — there is no in-app mute toggle by design (users mute via device
// volume). Keep these subtle and short (~120–180ms); they should read as a
// gentle chime, never a jarring alert.
//
// Autoplay policy: browsers won't let audio play until the user has interacted
// with the page once. We lazily create the AudioContext and resume it on the
// first user gesture (see initChatAudio). The "message sent" cue plays from
// inside the send handler, which IS a user gesture, so it warms the context;
// the "reply arrived" cue then reuses the already-running context. The very
// first page-load cue may be suppressed until that first interaction — that's
// expected and fine; we don't try to force it.

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null // very old browser with no Web Audio — silently no-op
  if (!ctx) {
    try { ctx = new AC() } catch { return null }
  }
  // A context created before the first gesture starts 'suspended'. resume() is
  // a harmless no-op once it's already running, so it's safe to call each time.
  if (ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ })
  return ctx
}

type Note = { freq: number; at: number; dur: number }

// Play a short tone built from a sequence of enveloped sine notes. Each note
// gets a quick attack + smooth exponential release so gating the oscillator
// on/off doesn't produce an audible click.
function playSequence(notes: Note[], peak: number) {
  const ac = getCtx()
  if (!ac || ac.state !== 'running') return // suspended (pre-gesture) → skip silently
  const now = ac.currentTime
  for (const n of notes) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = n.freq
    const t0 = now + n.at
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur)
    osc.connect(gain).connect(ac.destination)
    osc.start(t0)
    osc.stop(t0 + n.dur + 0.02)
  }
}

// Rising two-note cue — "message sent".
export function playSentTone() {
  playSequence(
    [
      { freq: 523.25, at: 0, dur: 0.09 },    // C5
      { freq: 783.99, at: 0.07, dur: 0.11 }, // G5
    ],
    0.09,
  )
}

// Falling two-note cue — "reply arrived". Lower pitch + slightly softer peak
// so it's unmistakably distinct from the rising send cue.
export function playReplyTone() {
  playSequence(
    [
      { freq: 587.33, at: 0, dur: 0.10 },   // D5
      { freq: 392.00, at: 0.08, dur: 0.12 }, // G4
    ],
    0.07,
  )
}

// Warm up + resume the AudioContext on the first user gesture so the cues work
// for the rest of the session. Idempotent; safe to call from a mount effect.
let warmed = false
export function initChatAudio() {
  if (typeof window === 'undefined' || warmed) return
  warmed = true
  const warm = () => { getCtx() }
  window.addEventListener('pointerdown', warm, { once: true })
  window.addEventListener('keydown', warm, { once: true })
}
