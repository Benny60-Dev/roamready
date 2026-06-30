import { create } from 'zustand'
import type { FeedbackType } from '../types'

/** Trip/session reference a "Report an issue" trigger can attach to feedback.
 *  In practice a trip page passes { tripId, tripName }; the planning/session
 *  page passes { sessionId } (no built trip exists yet). */
export interface FeedbackTripRef {
  tripId?: string
  tripName?: string
  sessionId?: string
}

interface UIState {
  feedbackModalOpen: boolean
  /** Optional category to preselect when the feedback modal opens (e.g. a
   *  "Report this bug" link passes 'BUG_REPORT'). Cleared on close and on any
   *  no-arg open, so a plain openFeedbackModal() always falls back to the
   *  FeedbackModal default (FEATURE_REQUEST). */
  feedbackPrefillType?: FeedbackType
  /** Trip/session the CURRENT feedback modal is tagged with. Resolved when the
   *  modal opens (see openFeedbackModal) and read by FeedbackModal at submit.
   *  Cleared on close. */
  feedbackTripId?: string
  feedbackTripName?: string
  feedbackSessionId?: string
  /** "Remember last trip" — the most recent built trip the user viewed, updated
   *  on every trip-page load (rememberTrip). Used as the BEST-GUESS fallback when
   *  feedback is opened from a surface with no trip of its own (e.g. a Help menu).
   *  An explicit ref passed to openFeedbackModal always wins over this. */
  lastTripId?: string
  lastTripName?: string
  /** Record the trip the user is currently viewing (call on trip load). */
  rememberTrip: (tripId: string, tripName: string) => void
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
  openFeedbackModal: (prefillType?: FeedbackType, ref?: FeedbackTripRef) => void
  closeFeedbackModal: () => void
  openPaywall: (feature?: string, opts?: { redirectOnDismiss?: string }) => void
  closePaywall: () => void
}

export const useUIStore = create<UIState>((set) => ({
  feedbackModalOpen: false,
  feedbackPrefillType: undefined,
  feedbackTripId: undefined,
  feedbackTripName: undefined,
  feedbackSessionId: undefined,
  lastTripId: undefined,
  lastTripName: undefined,
  paywallModal: { open: false },
  rememberTrip: (tripId, tripName) => set({ lastTripId: tripId, lastTripName: tripName }),
  // prefillType is set to undefined on a no-arg call, so a plain open never
  // inherits a stale category from a prior "report bug" open.
  //
  // Trip-tag resolution (precedence): an EXPLICIT ref with a tripId or sessionId
  // (on-page "Report an issue" buttons) always wins. Otherwise fall back to the
  // remembered last trip — that's the best-guess for opens from surfaces with no
  // trip of their own (Help menu). Plain no-arg open with no remembered trip →
  // all undefined (untagged feedback).
  openFeedbackModal: (prefillType, ref) =>
    set((state) => {
      const hasExplicit = !!(ref && (ref.tripId || ref.sessionId))
      return {
        feedbackModalOpen: true,
        feedbackPrefillType: prefillType,
        feedbackTripId: hasExplicit ? ref!.tripId : state.lastTripId,
        feedbackTripName: hasExplicit ? ref!.tripName : state.lastTripName,
        // sessionId is only ever explicit — we never "remember" a planning session.
        feedbackSessionId: hasExplicit ? ref!.sessionId : undefined,
      }
    }),
  closeFeedbackModal: () =>
    set({
      feedbackModalOpen: false,
      feedbackPrefillType: undefined,
      feedbackTripId: undefined,
      feedbackTripName: undefined,
      feedbackSessionId: undefined,
    }),
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
