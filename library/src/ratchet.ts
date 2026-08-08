// A lead is an absolute offset from where the input actually is, so applying it needs somewhere to apply
// it *to*. A rig drawing a marker has that: the true cursor position keeps arriving, so the whole lead can
// be added to it every frame and an over-eager guess is simply corrected by the next sample.
//
// A locked pointer has no such thing. There is no true heading to add an offset to, only a camera that has
// already been turned. Handing it the absolute lead every frame would give the lead back as soon as it
// shrank — which reads as the camera settling backwards after the hand has already stopped, and that is a
// worse artefact than the wrong heading it corrects. A wrong heading under a locked pointer is not even
// observable; a camera creeping the other way is.
//
// So only the growth is ever applied. The lead ratchets: it can pull the camera further along the way the
// hand is going, never back. What that costs is a permanent per-turn gain error — measured at 16-26% of
// one lead's worth of rotation, kept for the rest of the session — and what it buys is that nothing on
// screen ever moves against the hand.

import type { Vector2 } from './types.js'

export type LeadRatchet = ReturnType<typeof createLeadRatchet>

/** One ratchet per consumer: how far it has already been led is state. */
export const createLeadRatchet = () => {
  let appliedX = 0
  let appliedY = 0
  const out: Vector2 = { x: 0, y: 0 }

  // Growth only, and only towards the same side. A lead that shrinks, or crosses zero on its way the other
  // way, contributes nothing: the far side's growth is counted from zero once it gets there.
  const growth = (lead: number, applied: number) =>
    lead * applied >= 0 && Math.abs(lead) > Math.abs(applied) ? lead - applied : 0

  /**
   * How much to add this frame, given the lead the predictor is asking for. Call it once per frame with
   * every lead, including shrinking ones — it is the frames it returns zero for that make it a ratchet.
   *
   * The returned object is reused every call — read it, do not keep it.
   */
  const step = (lead: Vector2): Vector2 => {
    out.x = growth(lead.x, appliedX)
    out.y = growth(lead.y, appliedY)
    appliedX = lead.x
    appliedY = lead.y
    return out
  }

  /** Forgets how far it has led. Pair it with the predictor's own `reset`, or the first frame back applies
   * the whole standing lead as one frame of growth. */
  const reset = () => {
    appliedX = 0
    appliedY = 0
  }

  return { step, reset }
}
