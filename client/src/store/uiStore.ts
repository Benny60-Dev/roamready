import { create } from 'zustand'

interface UIState {
  feedbackModalOpen: boolean
  paywallModal: { open: boolean; feature?: string }
  openFeedbackModal: () => void
  closeFeedbackModal: () => void
  openPaywall: (feature?: string) => void
  closePaywall: () => void
}

export const useUIStore = create<UIState>((set) => ({
  feedbackModalOpen: false,
  paywallModal: { open: false },
  openFeedbackModal: () => set({ feedbackModalOpen: true }),
  closeFeedbackModal: () => set({ feedbackModalOpen: false }),
  openPaywall: (feature) => set({ paywallModal: { open: true, feature } }),
  closePaywall: () => set({ paywallModal: { open: false } }),
}))
