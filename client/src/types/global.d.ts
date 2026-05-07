// Global type augmentations for the client.
//
// Web Speech API: `Window.SpeechRecognition` is the standard name and
// `Window.webkitSpeechRecognition` is the still-shipped Chrome/Edge prefix.
// Both already exist as standalone DOM types via tsconfig's `lib: ["DOM"]`,
// but the Window augmentation is needed so we can read them from `window.`
// without TS narrowing them to never. Place is shared (was previously
// duplicated module-scoped in SessionPage) so any voice-input consumer
// picks it up automatically — see hooks/useVoiceInput.ts.
declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}

// Empty export turns this file into a module so the `declare global` block
// is treated as an augmentation rather than a script-scope script. Without
// it, the augmentation silently no-ops in some configurations.
export {}
