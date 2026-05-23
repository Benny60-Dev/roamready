import { create } from 'zustand'

interface UIState {
  feedbackModalOpen: boolean
  /** Paywall state.
   *  - open:               whether the modal is currently mounted
   *  - feature:            the FEATURE_GATES key that triggered the modal
   *                        (drives the "Unlock <Feature>" header)
   *  - redirectOnDismiss:  optional route the modal should navigate to when
   *                        the user dismisses it. Used by Pro-only pages
   *                        (OHV destinations, Van destinations, Trip
   *                        Booking) that render an empty shell behind the
   *                        modal — dismissing would otherwise strand the
   *                        user on a near-blank page. Pages where the
   *                        modal is layered over usable free content (a
   *                        Pro button on an otherwise-free page) leave
   *                        this unset; closing returns the user to that
   *                        same page in-place. PaywallModal itself
   *                        consumes this flag and calls navigate(); the
   *                        store stays router-agnostic. */
  paywallModal: { open: boolean; feature?: string; redirectOnDismiss?: string }
  openFeedbackModal: () => void
  closeFeedbackModal: () => void
  openPaywall: (feature?: string, opts?: { redirectOnDismiss?: string }) => void
  closePaywall: () => void
}

export const useUIStore = create<UIState>((set) => ({
  feedbackModalOpen: false,
  paywallModal: { open: false },
  openFeedbackModal: () => set({ feedbackModalOpen: true }),
  closeFeedbackModal: () => set({ feedbackModalOpen: false }),
  openPaywall: (feature, opts) =>
    set({
      paywallModal: {
        open: true,
        feature,
        redirectOnDismiss: opts?.redirectOnDismiss,
      },
    }),
  // Deliberately dumb: just flips the open flag and drops feature/
  // redirectOnDismiss along with it (the spread in openPaywall replaces
  // the whole object next time). Navigation is the modal's job, not the
  // store's, since the store can't cleanly use router hooks.
  closePaywall: () => set({ paywallModal: { open: false } }),
}))
