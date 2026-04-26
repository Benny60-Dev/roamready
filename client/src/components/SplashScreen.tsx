import { useEffect, useRef, useState } from 'react'

const SESSION_FLAG = 'rr_splash_seen'

export default function SplashScreen() {
  const [shown, setShown] = useState(() => {
    // Initial state: only show if this session hasn't seen it yet
    if (typeof window === 'undefined') return false
    return sessionStorage.getItem(SESSION_FLAG) !== '1'
  })
  const [fadingOut, setFadingOut] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Mark seen + dismiss
  const dismiss = () => {
    if (fadingOut) return
    setFadingOut(true)
    sessionStorage.setItem(SESSION_FLAG, '1')
    // Wait for fade-out transition before unmounting
    setTimeout(() => setShown(false), 300)
  }

  // Apply playback rate once video element is ready
  useEffect(() => {
    if (!shown || !videoRef.current) return
    videoRef.current.playbackRate = 2.0
  }, [shown])

  // ESC key dismisses
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown, fadingOut])

  if (!shown) return null

  return (
    <div
      className="fixed inset-0 z-[100] bg-black sm:bg-[#1F6F8B] flex items-center justify-center sm:p-8"
      style={{
        opacity: fadingOut ? 0 : 1,
        transition: 'opacity 300ms ease-out',
        pointerEvents: fadingOut ? 'none' : 'auto',
      }}
      role="dialog"
      aria-label="Brand intro"
    >
      <video
        ref={videoRef}
        src="/splash.mp4"
        autoPlay
        muted
        playsInline
        onEnded={dismiss}
        onError={dismiss}
        className="w-full h-full object-cover sm:object-contain sm:rounded-2xl sm:max-h-[80vh] sm:max-w-[600px] sm:w-auto sm:h-auto"
      />
      <button
        type="button"
        onClick={dismiss}
        className="absolute bottom-6 right-6 text-white/70 hover:text-white text-sm tracking-wide transition-colors"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '8px 12px' }}
      >
        Skip →
      </button>
    </div>
  )
}
