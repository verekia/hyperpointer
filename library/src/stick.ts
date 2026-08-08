// The touch-screen counterpart of createPointerBuffer, and it exists for the same reason: a frame needs
// the motion since the last frame, and most virtual joysticks do not offer that.
//
// What they usually offer is the delta of one touch event, cleared by a timeout rather than by anything
// that knows about frames. Reading that per frame is wrong in both directions at once: a frame landing
// between two touch events applies the previous delta a second time, and a frame that spans several sees
// only the last one and drops the rest.
//
// The fix is easier here than it is for a mouse, because a stick knows where it is. The change in its
// position across a frame is exactly the motion of that frame, however many events went into it, and it
// cannot be applied twice because reading it moves the mark.

import type { Vector2 } from './types.js'

/**
 * What a virtual joystick has to expose for this to read it: which touch it is following, and where that
 * touch is. Nulls mean the stick is not being held.
 */
export type StickReading = {
  identifier: number | null
  current: { x: number | null; y: number | null }
}

export type StickReader = ReturnType<typeof createStickReader>

/** One reader per stick: the mark it differences against is state. */
export const createStickReader = () => {
  let lastX: number | null = null
  let lastY: number | null = null
  let lastIdentifier: number | null = null
  const out: Vector2 = { x: 0, y: 0 }

  /**
   * How far the stick travelled since the last call. Call it every frame, including frames that will not
   * use the result — a delta left unread is a delta applied late, all at once, whenever the consumer comes
   * back.
   *
   * The returned object is reused every call — read it, do not keep it.
   */
  const read = (stick: StickReading): Vector2 => {
    const { x, y } = stick.current
    // A different finger is a different stroke, and the distance between where one lifted and the next
    // landed is not motion. Lifting and touching again inside the joystick's own reset delay leaves the
    // old position in place, so the identifier is what separates them, not whether there is a position.
    const sameTouch = stick.identifier !== null && stick.identifier === lastIdentifier
    const known = x !== null && y !== null && lastX !== null && lastY !== null

    out.x = sameTouch && known ? x - lastX! : 0
    out.y = sameTouch && known ? y - lastY! : 0

    lastX = x
    lastY = y
    lastIdentifier = stick.identifier
    return out
  }

  /** Drops the mark, so a consumer coming back does not apply the gap it was away for. */
  const reset = () => {
    lastX = null
    lastY = null
    lastIdentifier = null
  }

  return { read, reset }
}
