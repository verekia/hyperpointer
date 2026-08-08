// Pointer deltas are accumulated by the event and drained by the frame that applies them, so a stopped
// pointer always leaves 0 behind. Nothing outside the frame loop is responsible for clearing them.
//
// This is not the same job as "read the latest event in the frame loop", and getting it wrong costs motion
// in both directions at once. A frame that lands between two events re-applies a delta already spent; a
// frame that spans several sees only the last and drops the rest. Both look like input lag and neither is.
//
// The individual samples are kept alongside the sum, because a predictor fitting a curve to the motion
// needs when each part of it happened, and the sum has thrown that away.

// A 1000Hz mouse puts about 17 samples in a 60Hz frame. The rest is slack for a long frame; past that the
// oldest are dropped, which costs a fit nothing because it only looks at the last few tens of ms. The sum
// keeps every sample either way, so no motion is lost.
const CAPACITY = 128

/**
 * The shape this reads off a move event. `PointerEvent` and `MouseEvent` both satisfy it; so does a plain
 * object, which is what makes the accumulation testable without a DOM.
 */
export type PointerMoveLike = {
  movementX?: number
  movementY?: number
  timeStamp: number
  getCoalescedEvents?: () => readonly PointerMoveLike[]
}

export type PointerBufferOptions = {
  /**
   * Largest single-event delta accepted, per axis, in pixels. A pointer-lock recentre — or a device
   * waking up — can deliver one absurd event, and applied straight to a camera it whips it round. Clamping
   * on the way in rather than at the frame is what keeps the guard on the glitch instead of on the frame
   * that happened to contain it. Omitted means no clamp.
   */
  maxDeltaPx?: number
}

export type PointerFrame = {
  /** Everything accumulated since the last read. Raw pointer pixels, +Y down, as the DOM reports them. */
  x: number
  y: number
  /** The clock reading that produced this frame, so a frame reads the clock once. */
  nowMs: number
  /** How old the newest sample already was when the frame read it. The browser holds move events until
   * just before the animation frame, so this is never zero, and anything extrapolating from these deltas
   * has to start counting here rather than from now. */
  ageMs: number
  /** How many entries of the sample arrays below are valid. */
  sampleCount: number
  /** The samples behind x and y, oldest first. Reused every frame — read them, do not keep them. */
  sampleTimes: Float64Array
  sampleX: Float64Array
  sampleY: Float64Array
}

export type PointerBuffer = ReturnType<typeof createPointerBuffer>

/**
 * One buffer per consumer: it is drained by whoever reads it, and two readers would each get part of the
 * motion.
 */
export const createPointerBuffer = (options: PointerBufferOptions = {}) => {
  const maxDeltaPx = options.maxDeltaPx
  const clamp =
    maxDeltaPx === undefined
      ? (value: number) => value
      : (value: number) => Math.max(-maxDeltaPx, Math.min(maxDeltaPx, value))

  const sampleTimes = new Float64Array(CAPACITY)
  const sampleX = new Float64Array(CAPACITY)
  const sampleY = new Float64Array(CAPACITY)

  let pendingX = 0
  let pendingY = 0
  let pendingCount = 0
  let newestStamp = 0

  const frame: PointerFrame = {
    x: 0,
    y: 0,
    ageMs: 0,
    nowMs: 0,
    sampleCount: 0,
    sampleTimes,
    sampleX,
    sampleY,
  }

  /** One sample of motion. Call it per event, or per coalesced sample of one — never per frame. */
  const push = (timeStampMs: number, deltaX: number, deltaY: number) => {
    const dx = clamp(deltaX)
    const dy = clamp(deltaY)
    pendingX += dx
    pendingY += dy
    if (timeStampMs > newestStamp) newestStamp = timeStampMs

    if (pendingCount === CAPACITY) {
      sampleTimes.copyWithin(0, 1)
      sampleX.copyWithin(0, 1)
      sampleY.copyWithin(0, 1)
      pendingCount--
    }
    sampleTimes[pendingCount] = timeStampMs
    sampleX[pendingCount] = dx
    sampleY[pendingCount] = dy
    pendingCount++
  }

  // A browser hands over one move event per frame however fast the pointer reports, so on a platform that
  // samples faster than it draws, the samples inside that event are the motion. The spec makes the parent's
  // movement their sum, but a UA that gets that wrong loses everything the parent dropped — and one that
  // leaves the samples' own movement empty would lose everything if we trusted them blindly. Take the
  // samples one at a time, and fall back to the parent only when none of them carried anything.
  /** Feed one move event. Exported rather than left to `listen` because deciding which samples to believe
   * is the fiddly part, and it is worth testing without a DOM to hand. */
  const handle = (event: PointerMoveLike) => {
    const samples = event.getCoalescedEvents?.() ?? []

    // Whether any sample carried a movement at all, which is not the same question as whether they add up
    // to one. A hand going out and back inside a single frame — a shake, a correction — reports samples
    // that cancel, and reading that as "this UA does not fill in movement" would throw the samples away
    // and keep the parent's nothing in their place, losing the very motion hardest to guess at.
    let reported = false
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]!
      if ((sample.movementX || 0) !== 0 || (sample.movementY || 0) !== 0) {
        reported = true
        break
      }
    }

    if (!reported) {
      // The UA whose move events leave the samples' own movement empty. Its parent still carries the sum,
      // and `|| 0` is load-bearing: a missing field would otherwise turn the accumulator into NaN, and NaN
      // reaches the camera rotation, where there is no recovering from it.
      push(event.timeStamp, event.movementX || 0, event.movementY || 0)
      return
    }

    // Each sample carries its own generation time, which is what a fit over the motion needs.
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]!
      push(sample.timeStamp, sample.movementX || 0, sample.movementY || 0)
    }
  }

  /**
   * Everything since the last call, and nothing twice. Call it once per frame, before any early return
   * that might skip applying it — a delta left unread is a delta applied late, all at once, whenever the
   * consumer comes back.
   *
   * The returned object and its sample arrays are reused every call — read them, do not keep them.
   */
  const read = (nowMs = performance.now()): PointerFrame => {
    frame.x = pendingX
    frame.y = pendingY
    frame.nowMs = nowMs
    frame.ageMs = newestStamp > 0 ? Math.max(0, nowMs - newestStamp) : 0
    frame.sampleCount = pendingCount
    pendingX = 0
    pendingY = 0
    pendingCount = 0
    newestStamp = 0
    return frame
  }

  /** Throws away what has accumulated without applying it. */
  const clear = () => {
    pendingX = 0
    pendingY = 0
    pendingCount = 0
    newestStamp = 0
  }

  /**
   * Subscribes to move events and returns the unsubscribe. One source only: `pointermove` and `mousemove`
   * both fire for the same motion, so only the better of the two is used. Outside a browser this is a
   * no-op, so it is safe to call from code that also renders on a server.
   */
  const listen = (target?: EventTarget) => {
    const node = target ?? (typeof window === 'undefined' ? null : window)
    if (!node) return () => {}

    const hasCoalescedEvents = typeof PointerEvent !== 'undefined' && 'getCoalescedEvents' in PointerEvent.prototype
    const type = hasCoalescedEvents ? 'pointermove' : 'mousemove'
    const onMove = (event: Event) => handle(event as unknown as PointerMoveLike)

    node.addEventListener(type, onMove)
    return () => {
      node.removeEventListener(type, onMove)
      clear()
    }
  }

  return { push, handle, read, clear, listen }
}
