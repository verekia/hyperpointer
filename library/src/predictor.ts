// The frame drawn for refresh N is presented one to four refreshes later, and the hand has moved by then.
// Leading by the motion expected over that gap is the only thing that closes it, since the input itself
// already arrives as fast as the OS delivers it.
//
// What it returns is a lead in pointer pixels, on both axes, and nothing else. It knows nothing about what
// the pixels turn into — how far a pixel rotates a camera, whether one axis is damped against the other,
// which of the two a caller even uses. All of that is the caller's, and keeping it there is what makes the
// guess reusable: the cap in particular applies to the vector, so a caller that spends only one axis of it
// is throwing away lead it paid for.
//
// The lead is a least-squares fit through the raw samples of the last WINDOW_MS, not a smoothed velocity.
// A velocity estimator is systematically late: it lags a ramp by its own smoothing, so it under-leads the
// whole accelerating half of a flick and is still near full lead once the hand is already still. A
// quadratic carries the acceleration in its curvature, which is what a flick is almost entirely made of.
//
// **One predictor for both axes, not one per axis.** Seen one axis at a time, the extremum of a circling
// hand is indistinguishable from a hand that is stopping: its travel across the window goes to zero, so
// the speed gate reads a crawl, the direction guard has no direction, and the stop clamp cuts the horizon
// to nothing. All three are right for a flick that ends and all three are wrong here — they cancel exactly
// the inward part of the guess, which is why circling used to throw the lead outwards. In 2D none of them
// fire, because a circling hand never slows and never turns around. It turns.
//
// So the extrapolation follows an arc rather than a straight line. Speed and heading come from the fit;
// the turn rate is measured off the path, because over a wide arc a parabola fits the curvature badly but
// the heading of the window's newer half against its older half is just two chords. The arc degenerates to
// the straight line as the turn rate goes to zero, so straight motion is bit-identical.
//
// Freshness is the only stop signal. A stopped pointer sends nothing, so the lead fades out over STOP_MS
// rather than sailing on at the last fitted speed.
//
// Below a crawl there is no lead at all. Whole mouse counts are all a slow hand produces, and a fit over
// four of them is mostly quantisation. A caller that keeps what it is given rather than unwinding it keeps
// every upward wobble too, so left in, that noise became rotation for as long as the drag lasted.
//
// The parabola is believed only as far as the path bends more than a path of whole counts appears to bend
// when it is dead straight, and the answer slides back to the straight line as that margin closes. How
// many samples a window holds is the wrong question — it counts the ones that carried motion, so a fast
// mouse at the start of a flick looks as thin as a slow device, which is the moment the bend matters
// most, while a steady drag looks thick when there is no bend there to find. Asking how far the bend
// stands above the noise instead is both more accurate and steadier, and it is the same question whatever
// the device: a hand crossing a mouse pad reads the same on a wired mouse and one on a radio.

import type { PointerFrame } from './pointer.js'

// The tuned defaults, exported so that everything measuring this and everything using it agree: a lead
// measured on a rig only means something if it is the lead the thing being measured actually applies.
export const DEFAULT_LEAD_FRAMES = 1
export const DEFAULT_MAX_LEAD_PX = 100
export const DEFAULT_DECAY_MS = 30

const WINDOW_MS = 40
// The least time a window may cover and still be worth extrapolating from.
const MIN_SPAN_MS = 2
// A hand slower than this does not travel far enough inside the window to be told apart from the
// quantisation of whole mouse counts, so a fit over it reads mostly noise. Below SLOW there is no lead at
// all, and it ramps to the full figure by SURE. Both in pointer pixels per millisecond, measured on the
// path rather than on either axis, so a diagonal is not gated as though it were two slower motions.
const SLOW_PX_PER_MS = 0.08
const SURE_PX_PER_MS = 0.25
// How far a bend, or a turn, has to stand above what quantisation alone would produce before it is taken
// in full. Both are the same question asked of a different part of the fit.
const CURVE_SNR = 2
const TURN_SNR = 2
// A guess that bends further than this over one horizon is not a turn a hand makes; it is a fit that has
// run away.
const MAX_TURN_RAD = Math.PI / 2
// About one mouse count, which is how far off a chord that ends on whole counts can point. Used to work out
// how much of a measured turn is quantisation before any of it is believed.
const QUANTISATION_PX = 1
// How much a least-squares curvature wobbles for a given amount of that quantisation, over a window of a
// given length and sample count. Tuned on a steady drag, where every bit of curvature read is noise.
const ACCEL_NOISE = 20
// 40ms of a 1000Hz mouse is 40 samples. The rest is slack for a long frame; the oldest are dropped, which
// costs nothing because the window is shorter than the buffer.
const CAPACITY = 128
const STOP_MS = 32
// The longest quiet a device is known to keep while still moving decays at this rate per report, so one
// unusually long gap does not excuse silence forever. Multiplied by the tolerance before it counts.
const QUIET_DECAY = 0.92
const QUIET_TOLERANCE = 1.5
const MAX_ELAPSED_MS = 32
const NEGLIGIBLE_PX = 0.05
const FRAME_SMOOTHING = 0.1
// How much longer than the running estimate one frame is allowed to claim the refresh interval is.
const MAX_FRAME_STEP = 1.5
// How long to average the event-delivery lateness over. Long enough to ride out the per-frame wander,
// short enough to follow a machine that genuinely changes its delivery time.
const AGE_SMOOTHING_MS = 120
// How much longer the ramp gets when the window behind the guess is too thin to trust.
const NOISE_EASE = 3
// How long to settle the judgement about whether the path really bends. That judgement also decides how
// hard the lead is smoothed, so left to answer freshly every frame it switches the smoothing on and off.
const CURVE_TRUST_MS = 150
// How far back the heading a reversal is judged against is remembered, and how much of the interval
// between recent reversals may be extrapolated over.
const HEADING_MEMORY_MS = 25
const REVERSAL_HORIZON = 0.4

export type PredictorOptions = {
  /** How many display refreshes ahead to guess. This is a count of refreshes rather than a duration
   * because the delay it covers is a count of refreshes: the same setting has to mean half as long on a
   * 120Hz display. Which number is right is which depth the machine's present queue runs at, and nothing
   * inside a page can see that — measure it on a rig, by eye, against the OS cursor. */
  leadFrames?: number
  /** How far the caller is willing to be led, whatever the samples say — a feel setting, and the caller's
   * to choose. A fit has no ceiling of its own, so a whip banks a quarter turn of rotation on a caller
   * that keeps what it is given. Applied to the vector rather than to each axis, or a diagonal gets it
   * twice over. It is not a safety rail: the guard against a window too thin to extrapolate from is
   * internal, and clamping absurd single samples belongs on the way in (see `createPointerBuffer`). */
  maxLeadPx?: number
  /** Time constant of the ramp that eases the lead in and out, so a correction is a change of speed
   * rather than a jump. */
  decayMs?: number
}

export type PredictorUpdate = PredictorOptions & {
  /** The frame's clock reading, in the same clock as the pushed timestamps — `performance.now()` for DOM
   * event timestamps. */
  nowMs: number
  /** Time since the previous `update`. */
  deltaMs: number
}

export type Lead = {
  x: number
  y: number
  /** 1 while input is arriving as often as this device usually manages, falling to 0 once the silence is
   * long enough to be a stopped hand rather than the gap between reports. A caller wanting to drop the
   * lead the moment the hand stops should watch this, never whether a sample landed this frame: a mouse on
   * a radio leaves a third of frames empty while moving perfectly steadily. */
  live: number
}

export type PointerPredictor = ReturnType<typeof createPointerPredictor>

/**
 * One predictor per consumer, covering both axes: the sample window and the eased lead are state, and two
 * callers sharing them would each be fed the other's motion. Comparing two settings side by side likewise
 * needs one predictor each — a single instance cannot answer for both.
 */
export const createPointerPredictor = (options: PredictorOptions = {}) => {
  const defaultLeadFrames = options.leadFrames ?? DEFAULT_LEAD_FRAMES
  const defaultMaxLeadPx = options.maxLeadPx ?? DEFAULT_MAX_LEAD_PX
  const defaultDecayMs = options.decayMs ?? DEFAULT_DECAY_MS

  const times = new Float64Array(CAPACITY)
  const xs = new Float64Array(CAPACITY)
  const ys = new Float64Array(CAPACITY)
  let head = 0
  let count = 0
  let cumulativeX = 0
  let cumulativeY = 0

  let leadX = 0
  let leadY = 0
  let frameMs = 16.7
  let smoothedAge = 13
  let msSinceInput = 0
  let quietMs = 0
  let lastSeenNewest = 0
  // How much the window behind the last guess was worth. Drives how hard the guess is smoothed.
  let confidence = 1
  let curveConfidence = 0
  // Believed turn rate of the path, rad/ms, so the eased lead can be carried around with the heading.
  let carriedTurn = 0
  // A hand that has lately been doubling back, and how long it went between doing so. At the moment a
  // shake is fastest it is locally indistinguishable from a hand crossing the pad: same speed, and no
  // acceleration, because the turn is still ahead. Only the memory that it turned round a moment ago
  // separates them, and a memory of events survives that moment where any average does not.
  let headingX = 0
  let headingY = 0
  let msSinceReversal = 1e4
  let reversalPeriodMs = 1e4

  const out: Lead = { x: 0, y: 0, live: 1 }

  /** One coalesced sample: when the motion happened, and how far it went on each axis. */
  const push = (timeStampMs: number, deltaX: number, deltaY: number) => {
    cumulativeX += deltaX
    cumulativeY += deltaY
    times[head] = timeStampMs
    xs[head] = cumulativeX
    ys[head] = cumulativeY
    head = (head + 1) % CAPACITY
    if (count < CAPACITY) count++
  }

  /** Every sample a `createPointerBuffer` frame carried, in order. */
  const pushFrame = (frame: PointerFrame) => {
    for (let i = 0; i < frame.sampleCount; i++) {
      push(frame.sampleTimes[i]!, frame.sampleX[i]!, frame.sampleY[i]!)
    }
  }

  const clear = () => {
    count = 0
    head = 0
    cumulativeX = 0
    cumulativeY = 0
  }

  // Everything the window has to say about the path: where it is going, how that is changing, and how far
  // it actually went. Positions are centred on the newest sample, so the evaluation point is the origin,
  // the constant term drops out of every answer, and the normal equations stay well conditioned however
  // long the session runs.
  const fit = (horizonMs: number, deltaMs: number) => {
    const newest = (head - 1 + CAPACITY) % CAPACITY
    const newestT = times[newest]!
    const newestX = xs[newest]!
    const newestY = ys[newest]!

    let s0 = 0
    let s1 = 0
    let s2 = 0
    let s3 = 0
    let s4 = 0
    let xy0 = 0
    let xy1 = 0
    let xy2 = 0
    let yy0 = 0
    let yy1 = 0
    let yy2 = 0
    let travelX = 0
    let travelY = 0
    let span = 0
    let used = 0

    for (let i = 0; i < count; i++) {
      const index = (newest - i + CAPACITY) % CAPACITY
      const u = times[index]! - newestT
      if (-u > WINDOW_MS) break
      const px = xs[index]! - newestX
      const py = ys[index]! - newestY
      const u2 = u * u
      s0 += 1
      s1 += u
      s2 += u2
      s3 += u2 * u
      s4 += u2 * u2
      xy0 += px
      xy1 += u * px
      xy2 += u2 * px
      yy0 += py
      yy1 += u * py
      yy2 += u2 * py
      // What the hand actually did over the window, as opposed to what a curve through it says.
      travelX = -px
      travelY = -py
      span = -u
      used++
    }

    if (used < 2) return false
    // Nothing can be extrapolated over a horizon of tens of milliseconds from a window that covers a
    // fraction of one. Coalesced samples can arrive a microsecond apart, and a velocity read off two of
    // those is enormous and meaningless: uncapped it asked for eighteen thousand pixels of lead. This is
    // the library's own floor, not a feel setting — it says only that the samples do not support an
    // answer, where `maxLeadPx` says how far the caller is willing to be led.
    if (span < MIN_SPAN_MS) return false

    // Measured travel, not the fitted figure: the fit is the noisy thing, so trusting it to say how fast
    // the hand is going lets every spike through amplified. Under a crawl the lead is dropped entirely —
    // a caller that keeps what it is given keeps every upward wobble too, so jitter at a slow steady
    // drag accumulates for as long as the drag lasts.
    const travel = Math.hypot(travelX, travelY)
    const speed = span > 0 ? travel / span : 0
    const trust = Math.max(0, Math.min(1, (speed - SLOW_PX_PER_MS) / (SURE_PX_PER_MS - SLOW_PX_PER_MS)))
    if (trust === 0) return false

    const m00 = s2 * s4 - s3 * s3
    const m01 = s1 * s4 - s2 * s3
    const m02 = s1 * s3 - s2 * s2
    const detQuadratic = s0 * m00 - s1 * m01 + s2 * m02
    const detLinear = s0 * s2 - s1 * s1
    const canCurve = used >= 3 && Math.abs(detQuadratic) > 1e-9

    // Both readings of the same window: the straight line through it, and the parabola. The straight line
    // is steadier, the parabola is the only one that can see a hand speeding up or turning.
    let straight = 0
    let curved = 0
    let bend = 0
    const solve = (y0: number, y1: number, y2: number) => {
      straight = Math.abs(detLinear) < 1e-9 ? 0 : (s0 * y1 - s1 * y0) / detLinear
      if (!canCurve) {
        curved = straight
        bend = 0
        return
      }
      curved = (-y0 * m01 + y1 * (s0 * s4 - s2 * s2) - y2 * (s0 * s3 - s1 * s2)) / detQuadratic
      bend = 2 * ((y0 * m02 - y1 * (s0 * s3 - s1 * s2) + y2 * (s0 * s2 - s1 * s1)) / detQuadratic)
    }

    solve(xy0, xy1, xy2)
    const straightX = straight
    const curvedX = curved
    const bendX = bend
    solve(yy0, yy1, yy2)
    const straightY = straight
    const curvedY = curved
    const bendY = bend

    // How far the parabola is worth believing over the straight line: how hard the path bends, against how
    // hard a path of whole mouse counts appears to bend when it is dead straight. Sample count alone was
    // the wrong question — it counts the samples that carried motion, so the start of a flick on a fast
    // mouse looks exactly as thin as a slow device, and that is the moment the bend matters most.
    const bendFloor = (ACCEL_NOISE * QUANTISATION_PX) / (span * span * Math.sqrt(used))
    const measured =
      bendFloor > 0 ? Math.max(0, Math.min(1, (Math.hypot(bendX, bendY) / bendFloor - 1) / (CURVE_SNR - 1))) : 0
    // A bend sitting near its own noise floor answers this differently every frame, and the answer decides
    // both which fit to believe and how hard to smooth the result — so left raw it switches the smoothing
    // on and off and the lead lurches each time. A judgement about how much a window is worth must not be
    // the noisiest thing in the calculation. A real flick clears the floor several times over and reaches
    // full trust regardless of this.
    curveConfidence += (measured - curveConfidence) * (1 - Math.exp(-deltaMs / CURVE_TRUST_MS))
    const curveTrust = curveConfidence
    confidence = curveTrust

    const vx = straightX + (curvedX - straightX) * curveTrust
    const vy = straightY + (curvedY - straightY) * curveTrust
    const ax = bendX * curveTrust
    const ay = bendY * curveTrust

    const speedNow = Math.hypot(vx, vy)
    if (speedNow < 1e-6) return false
    // A fit that has ended up pointing somewhere the window never went is not describing this path.
    if (vx * travelX + vy * travelY <= 0) return false

    const tx = vx / speedNow
    const ty = vy / speedNow

    // Against a heading from a moment ago, so a hand going round a circle never counts as turning back:
    // it swings tens of degrees in that time, not past a right angle.
    const reversed = headingX * tx + headingY * ty < 0
    if (reversed) {
      reversalPeriodMs = msSinceReversal
      msSinceReversal = 0
    } else {
      msSinceReversal += deltaMs
      // Grows back on its own, so one stray reversal cannot shorten the horizon for good.
      reversalPeriodMs = Math.max(reversalPeriodMs, msSinceReversal)
    }
    const headingRate = 1 - Math.exp(-deltaMs / HEADING_MEMORY_MS)
    headingX += (tx - headingX) * headingRate
    headingY += (ty - headingY) * headingRate
    const nx = -ty
    const ny = tx

    // How far along its own path the hand goes. Past the point where the fit says it stops, it does not
    // keep going backwards: a guess may say the hand is about to slow or stop, it may not say the hand is
    // about to reverse, because that is a visible kick and the samples do not support it. A real reversal
    // turns the measured travel around within a window and is led normally from there.
    //
    // The curvature term is what makes a flick worth fitting, and it is also the noisiest thing here: a
    // second derivative taken off whole mouse counts wobbles by a few pixels of lead even when the hand is
    // going at a dead constant speed. Subtract what quantisation alone would produce, so constant speed
    // reads as constant and a flick still reads as a flick.
    const accelerationFloor = (ACCEL_NOISE * QUANTISATION_PX) / (span * span * Math.sqrt(used))
    const alongRaw = ax * tx + ay * ty
    const alongAcceleration = Math.sign(alongRaw) * Math.max(0, Math.abs(alongRaw) - accelerationFloor)
    // Never guess much further ahead than this hand has been going between turning round. Past that the
    // guess is extrapolating through a reversal it has no way to see, and on a quick shake it ran further
    // than the whole width of the motion.
    let horizon = Math.min(horizonMs, reversalPeriodMs * REVERSAL_HORIZON)
    if (alongAcceleration < 0 && speedNow + alongAcceleration * horizon < 0) {
      horizon = -speedNow / alongAcceleration
    }
    // The ramp is a first-order lag, so it trails its target by its own time constant times however fast
    // that target is genuinely moving — 18px of the 53 a flick costs, more than the estimator and the
    // model together. How fast the target moves is not a mystery to be differentiated out of a noisy
    // signal: the target is speed over the horizon, so it moves at the acceleration over the horizon, and
    // the acceleration is already here and already gated. Handing the ramp a target that far ahead leaves
    // it arriving on time. A hand at constant speed has no acceleration, so nothing is added and none of
    // the smoothing is given up where it is doing the work.
    const distance = speedNow * horizon + 0.5 * alongAcceleration * horizon * horizon

    // Turn rate straight off the path: the heading of the newer half of the window against the heading of
    // its older half, which is two chords rather than a second derivative.
    let turn = 0
    if (used >= 3 && span > 0) {
      const middle = (newest - (used >> 1) + CAPACITY) % CAPACITY
      const oldest = (newest - (used - 1) + CAPACITY) % CAPACITY
      const newX = newestX - xs[middle]!
      const newY = newestY - ys[middle]!
      const oldX = xs[middle]! - xs[oldest]!
      const oldY = ys[middle]! - ys[oldest]!
      const newLength = Math.hypot(newX, newY)
      const oldLength = Math.hypot(oldX, oldY)
      if (newLength > 1e-6 && oldLength > 1e-6) {
        const cross = (oldX * newY - oldY * newX) / (newLength * oldLength)
        const dot = (oldX * newX + oldY * newY) / (newLength * oldLength)
        // A chord ending on whole counts can point up to about half a count either side of where it
        // really points, so short chords carry an angle error that is pure quantisation. Off an axis the
        // two axes cross their count boundaries at different moments, the path becomes a zig-zag about
        // the true line, and a turn read straight off it wanders by more than any hand does.
        //
        // So the floor decides how far to believe the angle rather than being taken out of it. Subtracting
        // it is a flat tax: it removes as much from a turn a hand really made as from one only the counts
        // made up, and on a circle a hand does make that came to a third of the turn — which is most of
        // why the guess used to sit outside the circle.
        const floor = QUANTISATION_PX * (1 / newLength + 1 / oldLength)
        const angle = Math.atan2(cross, dot)
        const believed = floor > 0 ? Math.max(0, Math.min(1, (Math.abs(angle) / floor - 1) / (TURN_SNR - 1))) : 0
        turn = (angle / (span / 2)) * believed * curveTrust
        carriedTurn = turn
      }
    }

    const swept = Math.max(-MAX_TURN_RAD, Math.min(MAX_TURN_RAD, turn * horizon))
    let along = distance
    let across = 0
    if (Math.abs(swept) > 1e-4) {
      along = (distance / swept) * Math.sin(swept)
      across = (distance / swept) * (1 - Math.cos(swept))
    }

    out.x = (along * tx + across * nx) * trust
    out.y = (along * ty + across * ny) * trust
    return true
  }

  /**
   * The lead actually handed out is an eased version of the lead the fit asks for. The raw figure steps
   * the moment motion starts, so both ends are eased and the correction is a change in speed rather than
   * a jump.
   *
   * The returned object is reused every call — read it, do not keep it.
   */
  const update = (input: PredictorUpdate): Lead => {
    const { nowMs, deltaMs } = input
    const leadFrames = input.leadFrames ?? defaultLeadFrames
    const decayMs = input.decayMs ?? defaultDecayMs
    const maxLeadPx = input.maxLeadPx ?? defaultMaxLeadPx

    // What this wants is the refresh interval, and a hitch is not a change of refresh interval. Feeding
    // one in raw moves the estimate by a fifth, which is two frames of horizon, which is pixels of lead
    // handed over on the frame after every stall. Clamping what the average is allowed to see leaves a
    // real refresh change to walk there over a few frames and a stall to barely register.
    if (deltaMs > 0) frameMs += (Math.min(deltaMs, frameMs * MAX_FRAME_STEP) - frameMs) * FRAME_SMOOTHING

    const newestT = count > 0 ? times[(head - 1 + CAPACITY) % CAPACITY]! : 0
    const hadInput = count > 0 && newestT > lastSeenNewest
    lastSeenNewest = newestT

    // Silence is the only evidence a hand has stopped, but how long a moving hand goes quiet is a property
    // of the device. A wired mouse reports every millisecond; one on a radio reports in bursts and can say
    // nothing for twenty. Reading any of that as a stop scaled the lead down on every frame that landed
    // between reports and back up on the next one — a four-fold flicker on a Bluetooth mouse, while the
    // hand moved perfectly steadily. So the quiet each device is known to keep is tolerated first, and
    // only what exceeds it counts as stopping.
    if (hadInput) quietMs = Math.max(quietMs * QUIET_DECAY, msSinceInput)
    msSinceInput = hadInput ? 0 : msSinceInput + deltaMs

    const tolerated = Math.max(quietMs * QUIET_TOLERANCE, frameMs)
    const freshness = Math.max(0, 1 - Math.max(0, msSinceInput - tolerated) / STOP_MS)
    if (freshness === 0) {
      clear()
      lastSeenNewest = 0
    }

    // What has to be covered is the time since the motion actually happened, not since the frame started:
    // a sample is already a good fraction of a frame old by the time the browser hands it over.
    // How late the browser hands the events over is roughly a property of the machine, but the figure read
    // on any one frame wanders by a few milliseconds. Left raw it goes straight into the horizon, and a few
    // milliseconds of horizon is pixels of lead on a hand that is doing nothing new — measured at four
    // pixels of jump per frame under ordinary frame timing, which is worse than any noise in the fit. The
    // average is the part worth compensating for, so the average is what is used.
    if (hadInput) {
      const age = Math.max(0, nowMs - newestT)
      smoothedAge += (age - smoothedAge) * (1 - Math.exp(-deltaMs / AGE_SMOOTHING_MS))
    }
    const elapsed = hadInput ? smoothedAge : msSinceInput
    const horizon = Math.min(elapsed, MAX_ELAPSED_MS) + leadFrames * frameMs

    // Both of these describe the guess this frame produced, so a frame that produces none must not be left
    // holding the last one's. A stale confidence keeps the ramp long through a stop that should fade at the
    // ordinary rate, and a stale turn keeps spinning the lead as it fades — a hand that stops mid-circle
    // leaves one behind, and it goes on turning after the hand has not.
    confidence = 1
    carriedTurn = 0

    out.x = 0
    out.y = 0
    if (count > 0 && freshness > 0) fit(horizon, deltaMs)

    let targetX = out.x * freshness
    let targetY = out.y * freshness

    const cap = Math.abs(maxLeadPx)
    const magnitude = Math.hypot(targetX, targetY)
    if (magnitude > cap && magnitude > 0) {
      targetX = (targetX / magnitude) * cap
      targetY = (targetY / magnitude) * cap
    }

    // A guess from a thin window is smoothed harder than one from a full one. The ramp costs a good
    // device nothing and is the difference between a usable picture and a shaking one on a device that
    // reports a handful of times per window — and there is no telling the two apart in advance.
    // The ramp is there to smooth how big the guess is, not which way it points. Easing in world axes
    // does both, so a turning hand drags its lead behind the heading by the ramp's own time constant —
    // 27 degrees on an ordinary circle, which lands the guess outside it. Carrying what is already there
    // around by the turn the path is believed to have leaves the ramp smoothing only the shape. A path
    // that is not turning rotates by nothing, so straight motion is untouched.
    if (carriedTurn !== 0) {
      const swept = Math.max(-MAX_TURN_RAD, Math.min(MAX_TURN_RAD, carriedTurn * deltaMs))
      const cos = Math.cos(swept)
      const sin = Math.sin(swept)
      const spunX = leadX * cos - leadY * sin
      leadY = leadX * sin + leadY * cos
      leadX = spunX
    }

    const rate = 1 - Math.exp(-deltaMs / Math.max(decayMs * (1 + NOISE_EASE * (1 - confidence)), 1))
    leadX += (targetX - leadX) * rate
    leadY += (targetY - leadY) * rate
    if (Math.abs(leadX) < NEGLIGIBLE_PX) leadX = 0
    if (Math.abs(leadY) < NEGLIGIBLE_PX) leadY = 0

    out.x = leadX
    out.y = leadY
    out.live = freshness
    return out
  }

  /**
   * Drops the window and everything settled behind it. Call it whenever the pointer stops driving this
   * consumer — an unlocked pointer, a menu, a cutscene — or the next frame that resumes fits a curve
   * through motion from before the gap and applies the whole thing at once.
   */
  const reset = () => {
    clear()
    leadX = 0
    leadY = 0
    smoothedAge = 13
    msSinceInput = 0
    quietMs = 0
    lastSeenNewest = 0
    confidence = 1
    curveConfidence = 0
    carriedTurn = 0
    headingX = 0
    headingY = 0
    msSinceReversal = 1e4
    reversalPeriodMs = 1e4
  }

  return { push, pushFrame, update, reset }
}
