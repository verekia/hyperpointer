// The rig the guess is judged on, written down once so every test is judging the same thing: a hand moving
// along a known path, a device reporting that motion the way real hardware does, a frame loop reading the
// lead back out, and the handful of numbers that say whether the guess was worth having.
//
// The point of keeping it here rather than in any one test file is that the prediction is tuned from these
// numbers. A change to the fit moves all of them at once, and the only way to tell an improvement from a
// trade is to see the whole board — so the same replay feeds the assertions and `bun run bench`, and a
// scenario added here is scored by both.
//
// Everything is deterministic: the clock wander comes from a seeded generator, so a figure measured today is
// the figure measured on the next machine. Any number in a test file was read off this rig and given room.

import { createPointerPredictor, DEFAULT_DECAY_MS, DEFAULT_LEAD_FRAMES, DEFAULT_MAX_LEAD_PX } from '../predictor.js'

export const FRAME = 16.7
/** What the newest sample's age measures at at 60Hz, per the example rig. */
export const AGE = 13
export const LEAD_FRAMES = DEFAULT_LEAD_FRAMES

/** Refresh intervals worth replaying at. The lead is a count of refreshes, so each of these is a different
 * horizon in milliseconds off the same hand. */
export const HZ_30 = 1000 / 30
export const HZ_60 = 1000 / 60
export const HZ_120 = 1000 / 120
export const HZ_144 = 1000 / 144

export type Vec = { x: number; y: number }
/** Where the hand is at a given moment, in pointer pixels. Continuous — the quantisation is the device's
 * job, and modelling it here would hide the thing most likely to wreck a second derivative. */
export type Path = (t: number) => Vec

/** How a device reports: how often, how many at a time, how much its clock wanders, and how coarse a step
 * one of its counts is worth. */
export type Device = {
  name: string
  periodMs: number
  burst: number
  jitterMs: number
  /** Pointer pixels per count. A high-DPI mouse at default sensitivity moves about a pixel per count; a low
   * one moves several, and a fit over four of those is looking at a staircase rather than a path. */
  countPx: number
}

const device = (name: string, periodMs: number, burst: number, jitterMs: number, countPx = 1): Device => ({
  name,
  periodMs,
  burst,
  jitterMs,
  countPx,
})

export const WIRED = device('wired', 1, 1, 0.1)
export const TRACKPAD = device('trackpad', 11, 1, 0.4)
/** A mouse on a radio: reports in clumps, and says nothing at all for a third of frames while moving. */
export const BLUETOOTH = device('bluetooth', 8, 3, 2.5)
/** Slower still, and the one whose gaps most resemble a hand that has stopped. */
export const SLOW_RADIO = device('slow radio', 16, 2, 3)
/** The default of every mouse that is not a gaming one: one report per 8ms, which is two per frame. */
export const USB_125 = device('125Hz mouse', 8, 1, 0.5)
export const USB_500 = device('500Hz mouse', 2, 1, 0.2)
/** Eight reports per millisecond, so the window is full and every sample carries almost no motion — the
 * case where a second derivative is being asked of nothing but quantisation. */
export const USB_8K = device('8KHz mouse', 0.125, 1, 0.05)
/** Coarse counts: four pixels a step, which is what a low-DPI mouse reports. The path arrives as a
 * staircase, and every noise floor in the fit is written in units of one count. */
export const COARSE = device('low-DPI mouse', 8, 1, 0.5, 4)
/** The sparsest thing that still calls itself a pointer: less than one report a frame, so most frames see
 * nothing and the window holds two or three samples. */
export const SPARSE = device('sparse', 25, 1, 4)

/** The four the shipped figures are quoted against. */
export const DEVICES: readonly Device[] = [WIRED, TRACKPAD, BLUETOOTH, SLOW_RADIO]
/** Every device, including the awkward ones that exist to be survived rather than to be fast. */
export const ALL_DEVICES: readonly Device[] = [
  WIRED,
  USB_8K,
  USB_500,
  USB_125,
  TRACKPAD,
  BLUETOOTH,
  SLOW_RADIO,
  COARSE,
  SPARSE,
]

export type ReplayOptions = {
  path: Path
  device: Device
  durationMs: number
  /** Stalls one frame in this many to three times its length, as a real one does. 0 for none. */
  hitchEvery?: number
  frameMs?: number
  leadFrames?: number
  decayMs?: number
  maxLeadPx?: number
  /** When scoring starts, so the window filling up is not read as steady-state behaviour. */
  scoreAfterMs?: number
  /** How long before the frame the browser stops handing events over. A couple of milliseconds is an
   * ordinary machine; a busy main thread, a compositor under load or a device driver having a bad day make
   * it tens, and every one of them goes into the horizon as time the guess has to cover. */
  deliveryLagMs?: number
  /** How many refreshes after a frame is drawn it reaches the screen — what the guess is scored against.
   * Defaults to `leadFrames`, which is the assumption the lead is set from. */
  presentFrames?: number
  seed?: number
  /** Every frame as it happens, for the properties that are about each frame rather than about the run: a
   * lead that is finite, inside the cap, and pointing somewhere the samples support. Scored frames only are
   * not enough for those — a guess that goes wrong while the window is filling has still gone wrong. */
  onFrame?: (frame: {
    /** Frame index from 1, and the clock reading it was drawn at. */
    index: number
    frameAt: number
    lead: { x: number; y: number; live: number }
    /** Where the hand truly is, where the device has said it is, and what the screen would show. */
    hand: Vec
    reported: Vec
    shown: Vec
    /** What the hand did since the previous frame. Zero while it is still. */
    handStep: Vec
  }) => void
}

export type Metrics = {
  /** Frames scored, so a figure averaged over them can be read for what it is. */
  frames: number
  /** Frame-to-frame move of the lead. On a hand doing nothing new every bit of it is jitter, and jitter on
   * a camera is nauseating, so the worst one matters more than the average. */
  worstStep: number
  meanStep: number
  /** A step that is itself a change of step: the lead changing speed, which is what the eye reads as
   * shaking rather than as motion. */
  worstJerk: number
  /** How much the size of the guess jumps in one frame, and how much its heading jumps against the hand's.
   * On a curving path most of `worstStep` is the lead legitimately swinging round with the hand — it is
   * 10px a frame on an ordinary circle and none of it is jitter — so these two are what steadiness means
   * anywhere except a straight line. Degrees for the second. */
  worstSizeStep: number
  worstTurnStep: number
  /** RMS distance from where the hand really is when this frame reaches the screen. */
  error: number
  /** The same, for a caller that does not guess at all. The only thing `error` means anything against. */
  errorWithout: number
  /** error / errorWithout. Under 1 is worth having; over 1 is worse than nothing. */
  gain: number
  /** Mean signed distance along the way the hand is going: positive is systematically ahead of the hand,
   * negative is systematically behind it. Which side of zero the errors sit on, rather than how big. */
  bias: number
  /** Furthest past the hand the guess ever sat, along the way the hand is going. Lead that was never needed
   * has to be handed back, and handing it back walks the view backwards under the hand. */
  worstOvershoot: number
  /** Furthest behind the hand it ever sat: the lateness the library exists to remove. Scored apart from
   * overshoot because the two are not the same mistake. */
  worstLate: number
  /** Total on-screen travel against the way the hand is moving at that moment, over the whole run. Measured
   * against what the hand did between these two frames rather than against a fixed direction, so a hand
   * that genuinely turns round is not scored as the picture fighting it. Overshoot being handed back and
   * jitter both land here, and this is the one artefact a camera cannot hide. */
  backwards: number
  /** The worst of that in a single frame — one visible kick rather than a slow drift back. */
  worstBackwards: number
  /** On-screen travel over frames where the hand is not moving at all: motion nobody asked for, in either
   * direction. A guess still holding lead when the hand stops has to give every pixel of it back, and this
   * is what that costs. */
  phantom: number
  worstLead: number
  meanLead: number
  /** How far the guessed position sits from the origin, averaged. Only means something on a circle, where
   * it is the radius the guess draws against the radius the hand drew. */
  meanRadius: number
  /** What a caller applying only the growth accumulates. Jitter is rectified into rotation there: every
   * upward wobble is kept and none of the downward ones give it back. */
  kept: number
  /** Frames the predictor called dead while the hand was in fact moving. A stop seen late is overshoot; a
   * stop seen where there is none is the lead dropping out under a moving hand. */
  falseDeadFrames: number
}

/** What a caller applying only the growth of the lead would keep from this frame: an axis moving further
 * out in the direction it already pointed, and nothing given back when it comes in again. */
const growth = (value: number, applied: number) =>
  value * applied >= 0 && Math.abs(value) > Math.abs(applied) ? value - applied : 0

/** An angle difference brought back into a half turn either side, so a swing past pi is read as the small
 * turn it is rather than as a nearly whole one. */
const wrapped = (angle: number) => {
  let value = angle
  while (value > Math.PI) value -= 2 * Math.PI
  while (value < -Math.PI) value += 2 * Math.PI
  return value
}

/**
 * One run of a hand along `path`, reported by `device`, read by a frame loop, scored against where the hand
 * really is when each frame reaches the screen.
 */
export const replay = (options: ReplayOptions): Metrics => {
  const {
    path,
    device: dev,
    durationMs,
    hitchEvery = 0,
    frameMs = FRAME,
    leadFrames = LEAD_FRAMES,
    decayMs = DEFAULT_DECAY_MS,
    maxLeadPx = DEFAULT_MAX_LEAD_PX,
    scoreAfterMs = 600,
    presentFrames = leadFrames,
    deliveryLagMs = 2,
    seed = 20260808,
    onFrame,
  } = options

  const predictor = createPointerPredictor()
  let rndState = seed
  const rnd = () => (rndState = (rndState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

  // Whole counts, and a count is not always a pixel.
  const countPx = dev.countPx
  const quantise = (value: number) => Math.trunc(value / countPx) * countPx

  let reportedX = 0
  let reportedY = 0
  let integratedX = 0
  let integratedY = 0
  let frameAt = 0
  let prevFrameAt = 0
  let nextReport = 0
  let previous: Vec | null = null
  let previousStep: Vec | null = null
  let previousShown: Vec | null = null
  let keptX = 0
  let keptY = 0
  let appliedX = 0
  let appliedY = 0
  let worstStep = 0
  let stepSum = 0
  let worstJerk = 0
  let worstSizeStep = 0
  let worstTurnStep = 0
  let previousRelativeAngle: number | null = null
  let previousHandAngle: number | null = null
  let phantom = 0
  let worstLead = 0
  let leadSum = 0
  let worstOvershoot = 0
  let worstLate = 0
  let backwards = 0
  let worstBackwards = 0
  let biasSum = 0
  let radialSum = 0
  let withSum = 0
  let withoutSum = 0
  let falseDeadFrames = 0
  let scored = 0

  let frameIndex = 0
  while (frameAt <= durationMs) {
    frameIndex++
    frameAt += frameMs * (hitchEvery > 0 && frameIndex % hitchEvery === 0 ? 3 : 1)
    // Events are held until shortly before the callback, and arrive a burst at a time.
    while (nextReport <= frameAt - deliveryLagMs) {
      for (let b = 0; b < dev.burst; b++) {
        const t = nextReport - (dev.burst - 1 - b) * dev.periodMs + (rnd() - 0.5) * dev.jitterMs
        if (t <= 0) continue
        const at = path(t)
        const dx = quantise(at.x) - reportedX
        const dy = quantise(at.y) - reportedY
        if (dx !== 0 || dy !== 0) {
          predictor.push(t, dx, dy)
          reportedX += dx
          reportedY += dy
          integratedX += dx
          integratedY += dy
        }
      }
      nextReport += dev.periodMs * dev.burst
    }

    // What the hand itself did over this frame, which is what everything on screen is judged against. Read
    // before the frame clock moves on, since that is what it is a difference against.
    const from = path(prevFrameAt)
    const to = path(frameAt)
    const handX = to.x - from.x
    const handY = to.y - from.y
    const handStep = Math.hypot(handX, handY)
    const moving = handStep > 0.02 * (frameAt - prevFrameAt)

    const lead = predictor.update({
      nowMs: frameAt,
      deltaMs: frameAt - prevFrameAt,
      leadFrames,
      decayMs,
      maxLeadPx,
    })
    prevFrameAt = frameAt

    keptX += growth(lead.x, appliedX)
    keptY += growth(lead.y, appliedY)
    appliedX = lead.x
    appliedY = lead.y

    // Once the window is full of the motion rather than of starting up.
    if (frameAt > scoreAfterMs) {
      const step = previous ? Math.hypot(lead.x - previous.x, lead.y - previous.y) : 0
      if (previous) {
        worstStep = Math.max(worstStep, step)
        stepSum += step
        const stepVec = { x: lead.x - previous.x, y: lead.y - previous.y }
        if (previousStep) {
          worstJerk = Math.max(worstJerk, Math.hypot(stepVec.x - previousStep.x, stepVec.y - previousStep.y))
        }
        previousStep = stepVec
        worstSizeStep = Math.max(
          worstSizeStep,
          Math.abs(Math.hypot(lead.x, lead.y) - Math.hypot(previous.x, previous.y)),
        )
      }
      // Where the guess points against where the hand is going. A lead swinging round with a turning hand
      // holds this still; a lead being shaken about by noise does not. Below a pixel there is no heading to
      // read and the size step has it covered, and a hand that has itself turned by a quarter turn between
      // two frames is asking a question about the reversal rather than about steadiness.
      const handAngle = Math.atan2(handY, handX)
      const handTurned = previousHandAngle === null ? 0 : Math.abs(wrapped(handAngle - previousHandAngle))
      previousHandAngle = moving ? handAngle : null
      if (moving && handTurned < Math.PI / 4 && Math.hypot(lead.x, lead.y) > 1) {
        const relative = Math.atan2(lead.y, lead.x) - handAngle
        if (previousRelativeAngle !== null) {
          const turned = wrapped(relative - previousRelativeAngle)
          worstTurnStep = Math.max(worstTurnStep, Math.abs((turned * 180) / Math.PI))
        }
        previousRelativeAngle = relative
      } else {
        previousRelativeAngle = null
      }
      const truth = path(frameAt + presentFrames * frameMs)

      // How far past the hand the guess sits, along the way the hand is going. Overshooting and falling
      // short are not the same error and are not worth scoring as one: lead that was never there has to
      // be handed back, and handing it back is a reversal on screen, where falling short is only the
      // lateness this whole thing exists to remove.
      const ahead = path(frameAt + presentFrames * frameMs + 1)
      const behind = path(frameAt + presentFrames * frameMs - 1)
      const towardsX = ahead.x - behind.x
      const towardsY = ahead.y - behind.y
      const towards = Math.hypot(towardsX, towardsY)
      const shownX = integratedX + lead.x
      const shownY = integratedY + lead.y
      if (towards > 1e-9) {
        const past = ((shownX - truth.x) * towardsX + (shownY - truth.y) * towardsY) / towards
        worstOvershoot = Math.max(worstOvershoot, past)
        worstLate = Math.max(worstLate, -past)
        biasSum += past
        // The hand is demonstrably moving here, so a dead reading is the predictor losing a moving hand
        // rather than noticing a stopped one.
        if (moving && lead.live === 0) falseDeadFrames++
      }
      // What the screen does against what the hand does over the same frame. A picture moving the other way
      // is the guess handing something back, whether it was overshoot or noise; a picture moving at all
      // while the hand is still is motion nobody asked for.
      if (previousShown) {
        const movedX = shownX - previousShown.x
        const movedY = shownY - previousShown.y
        if (moving) {
          const along = (movedX * handX + movedY * handY) / handStep
          if (along < 0) {
            backwards -= along
            worstBackwards = Math.max(worstBackwards, -along)
          }
        } else {
          phantom += Math.hypot(movedX, movedY)
        }
      }
      withSum += (shownX - truth.x) ** 2 + (shownY - truth.y) ** 2
      withoutSum += (integratedX - truth.x) ** 2 + (integratedY - truth.y) ** 2
      radialSum += Math.hypot(shownX, shownY)
      const magnitude = Math.hypot(lead.x, lead.y)
      worstLead = Math.max(worstLead, magnitude)
      leadSum += magnitude
      previousShown = { x: shownX, y: shownY }
      scored++
    }
    previous = { x: lead.x, y: lead.y }
    onFrame?.({
      index: frameIndex,
      frameAt,
      lead: { x: lead.x, y: lead.y, live: lead.live },
      hand: to,
      reported: { x: reportedX, y: reportedY },
      shown: { x: integratedX + lead.x, y: integratedY + lead.y },
      handStep: { x: handX, y: handY },
    })
  }

  const frames = Math.max(1, scored)
  const error = Math.sqrt(withSum / frames)
  const errorWithout = Math.sqrt(withoutSum / frames)
  return {
    frames: scored,
    worstStep,
    meanStep: stepSum / frames,
    worstJerk,
    worstSizeStep,
    worstTurnStep,
    error,
    errorWithout,
    gain: errorWithout > 1e-9 ? error / errorWithout : error > 1e-9 ? Infinity : 0,
    bias: biasSum / frames,
    worstOvershoot,
    worstLate,
    backwards,
    worstBackwards,
    phantom,
    worstLead,
    meanLead: leadSum / frames,
    meanRadius: radialSum / frames,
    kept: Math.hypot(keptX, keptY),
    falseDeadFrames,
  }
}

/** The worst reading of every number across a set of devices, which is what a floor has to hold at. */
export const worstAcross = (devices: readonly Device[], options: Omit<ReplayOptions, 'device'>): Metrics => {
  let worst: Metrics | null = null
  for (const dev of devices) {
    const run = replay({ ...options, device: dev })
    if (!worst) {
      worst = run
      continue
    }
    worst = {
      frames: Math.min(worst.frames, run.frames),
      worstStep: Math.max(worst.worstStep, run.worstStep),
      meanStep: Math.max(worst.meanStep, run.meanStep),
      worstJerk: Math.max(worst.worstJerk, run.worstJerk),
      worstSizeStep: Math.max(worst.worstSizeStep, run.worstSizeStep),
      worstTurnStep: Math.max(worst.worstTurnStep, run.worstTurnStep),
      error: Math.max(worst.error, run.error),
      errorWithout: Math.max(worst.errorWithout, run.errorWithout),
      gain: Math.max(worst.gain, run.gain),
      bias: Math.abs(run.bias) > Math.abs(worst.bias) ? run.bias : worst.bias,
      worstOvershoot: Math.max(worst.worstOvershoot, run.worstOvershoot),
      worstLate: Math.max(worst.worstLate, run.worstLate),
      backwards: Math.max(worst.backwards, run.backwards),
      worstBackwards: Math.max(worst.worstBackwards, run.worstBackwards),
      phantom: Math.max(worst.phantom, run.phantom),
      worstLead: Math.max(worst.worstLead, run.worstLead),
      meanLead: Math.min(worst.meanLead, run.meanLead),
      meanRadius: Math.max(worst.meanRadius, run.meanRadius),
      kept: Math.max(worst.kept, run.kept),
      falseDeadFrames: Math.max(worst.falseDeadFrames, run.falseDeadFrames),
    }
  }
  if (!worst) throw new Error('worstAcross needs at least one device')
  return worst
}

// ---------------------------------------------------------------------------------------------------------
// Paths. A hand does a small number of things, and each of them breaks a different part of the guess: steady
// motion is where jitter shows, a stop is where overshoot shows, a turn is where a per-axis fit falls apart,
// and a reversal is where extrapolating at all stops being safe.
// ---------------------------------------------------------------------------------------------------------

const radians = (degrees: number) => (degrees * Math.PI) / 180

/** A leg of a path: where it goes over its own lifetime, starting from wherever the previous one left off.
 * `at(0)` must be the origin, or the path teleports at the seam. */
export type Segment = { durationMs: number; at: (u: number) => Vec }

/** Segments laid end to end, each starting where the last one finished, holding the final position for ever
 * after — which is what a hand that has stopped does, and what the score has to be able to ask about. */
export const piecewise = (segments: readonly Segment[]): Path => {
  const starts: number[] = []
  const offsets: Vec[] = []
  let startAt = 0
  let ox = 0
  let oy = 0
  for (const segment of segments) {
    starts.push(startAt)
    offsets.push({ x: ox, y: oy })
    const end = segment.at(segment.durationMs)
    ox += end.x
    oy += end.y
    startAt += segment.durationMs
  }
  return (t: number) => {
    if (t <= 0 || segments.length === 0) return { x: 0, y: 0 }
    let index = segments.length - 1
    while (index > 0 && t < starts[index]!) index--
    const segment = segments[index]!
    const local = segment.at(Math.min(t - starts[index]!, segment.durationMs))
    return { x: offsets[index]!.x + local.x, y: offsets[index]!.y + local.y }
  }
}

/** A hand sitting still. */
export const hold = (durationMs: number): Segment => ({ durationMs, at: () => ({ x: 0, y: 0 }) })

/** Constant speed in a straight line. */
export const glide = (speed: number, angleDeg: number, durationMs: number): Segment => ({
  durationMs,
  at: (u: number) => ({ x: speed * Math.cos(radians(angleDeg)) * u, y: speed * Math.sin(radians(angleDeg)) * u }),
})

/** Rest to full speed over the segment, on a cosine — a hand starting a movement rather than a step
 * function. */
export const easeUp = (speed: number, angleDeg: number, durationMs: number): Segment => ({
  durationMs,
  at: (u: number) => {
    const travelled = speed * (u / 2 - (durationMs / (2 * Math.PI)) * Math.sin((Math.PI * u) / durationMs))
    return { x: Math.cos(radians(angleDeg)) * travelled, y: Math.sin(radians(angleDeg)) * travelled }
  },
})

/** Full speed to a dead stop over the segment, on a cosine — a hand letting go. */
export const easeDown = (speed: number, angleDeg: number, durationMs: number): Segment => ({
  durationMs,
  at: (u: number) => {
    const travelled = speed * (u / 2 + (durationMs / (2 * Math.PI)) * Math.sin((Math.PI * u) / durationMs))
    return { x: Math.cos(radians(angleDeg)) * travelled, y: Math.sin(radians(angleDeg)) * travelled }
  },
})

/** A point-to-point move that starts and ends at rest: smoothstep, which is what a hand moving something
 * somewhere deliberately looks like. */
export const smoothMove = (distancePx: number, angleDeg: number, durationMs: number): Segment => ({
  durationMs,
  at: (u: number) => {
    const s = Math.min(1, Math.max(0, u / durationMs))
    const travelled = distancePx * s * s * (3 - 2 * s)
    return { x: Math.cos(radians(angleDeg)) * travelled, y: Math.sin(radians(angleDeg)) * travelled }
  },
})

/** Constant speed around a bend of a given radius: the turn a hand actually makes at a corner, as opposed
 * to the instantaneous heading change of `glide` into `glide`. */
export const arc = (speed: number, radiusPx: number, sweepDeg: number, headingDeg: number): Segment => {
  const sweep = radians(sweepDeg)
  const sign = Math.sign(sweep) || 1
  const heading = radians(headingDeg)
  // The centre sits one radius off to the side the hand is turning towards.
  const cx = -Math.sin(heading) * radiusPx * sign
  const cy = Math.cos(heading) * radiusPx * sign
  return {
    durationMs: (Math.abs(sweep) * radiusPx) / speed,
    at: (u: number) => {
      const turned = ((speed * u) / radiusPx) * sign
      const cos = Math.cos(turned)
      const sin = Math.sin(turned)
      // Where the starting point ends up after being swung about that centre.
      return { x: cx - cx * cos + cy * sin, y: cy - cx * sin - cy * cos }
    },
  }
}

/** Constant acceleration from rest — the half of a movement a velocity estimator is systematically late on,
 * and the half a curvature is supposed to catch. */
export const accelerate = (accelPxPerMs2: number, angleDeg: number, durationMs: number): Segment => ({
  durationMs,
  at: (u: number) => {
    const travelled = 0.5 * accelPxPerMs2 * u * u
    return { x: Math.cos(radians(angleDeg)) * travelled, y: Math.sin(radians(angleDeg)) * travelled }
  },
})

export const steady =
  (speed: number, angleDeg: number): Path =>
  (t: number) => ({ x: speed * Math.cos(radians(angleDeg)) * t, y: speed * Math.sin(radians(angleDeg)) * t })

export const shake =
  (amplitude: number, hz: number): Path =>
  (t: number) => ({ x: amplitude * Math.sin((2 * Math.PI * hz * t) / 1000), y: 0 })

export const circle =
  (r: number, periodMs: number, direction: 1 | -1 = 1): Path =>
  (t: number) => ({
    x: r * Math.cos((2 * Math.PI * t) / periodMs),
    y: direction * r * Math.sin((2 * Math.PI * t) / periodMs),
  })

/** A lemniscate: the curvature reverses sign smoothly twice a lap, which is the one shape that asks the arc
 * extrapolation to change which way it bends without the hand ever slowing or turning back. */
export const figureEight =
  (r: number, periodMs: number): Path =>
  (t: number) => {
    const w = (2 * Math.PI * t) / periodMs
    return { x: r * Math.sin(w), y: r * Math.sin(w) * Math.cos(w) }
  }

/** Round and outwards: the radius and the speed both grow, so the turn rate the fit reads has to keep
 * falling while the speed keeps rising. */
export const spiral =
  (r0: number, growthPxPerMs: number, periodMs: number): Path =>
  (t: number) => {
    const r = r0 + growthPxPerMs * t
    const w = (2 * Math.PI * t) / periodMs
    return { x: r * Math.cos(w), y: r * Math.sin(w) }
  }

/** Advancing while weaving: constant forward speed with a sinusoidal wander across it, which is a hand
 * tracking something that will not hold still. */
export const serpentine =
  (speed: number, angleDeg: number, amplitude: number, periodMs: number): Path =>
  (t: number) => {
    const along = speed * t
    const across = amplitude * Math.sin((2 * Math.PI * t) / periodMs)
    const heading = radians(angleDeg)
    return {
      x: along * Math.cos(heading) - across * Math.sin(heading),
      y: along * Math.sin(heading) + across * Math.cos(heading),
    }
  }

/** A triangle wave: constant speed with instantaneous reversals, so there is no curvature anywhere to see
 * the turn coming and the whole warning is that it happened. */
export const zigzag =
  (speed: number, angleDeg: number, legMs: number): Path =>
  (t: number) => {
    const leg = Math.floor(t / legMs)
    const u = t - leg * legMs
    const along = leg % 2 === 0 ? speed * u : speed * (legMs - u)
    const heading = radians(angleDeg)
    return { x: along * Math.cos(heading), y: along * Math.sin(heading) }
  }

/** A hand that throws the view somewhere and lets go: a cruise, then a cosine ease down to a dead stop over
 * fallMs. The stop is the whole point — it is the one moment the guess is asked to give back everything it
 * is holding, and the moment it is furthest from being able to see it coming. */
export const flick = (speed: number, angleDeg: number, cruiseMs: number, fallMs: number): Path => {
  const ux = Math.cos(radians(angleDeg))
  const uy = Math.sin(radians(angleDeg))
  const travelled = (t: number) => {
    if (t <= cruiseMs) return speed * t
    const u = Math.min(t - cruiseMs, fallMs)
    return speed * (cruiseMs + u / 2 + (fallMs / (2 * Math.PI)) * Math.sin((Math.PI * u) / fallMs))
  }
  return (t: number) => ({ x: ux * travelled(t), y: uy * travelled(t) })
}

/** Anything, with a hand's tremor on top of it. A hand holding a mouse still is not still, and the wobble is
 * the same size as the counts the device reports — which is exactly where a curvature reads it as motion. */
export const withTremor =
  (path: Path, amplitude: number, hz: number): Path =>
  (t: number) => {
    const base = path(t)
    const wobble = amplitude * Math.sin((2 * Math.PI * hz * t) / 1000)
    // Across both axes at different rates, so it is not a motion the fit can lock onto.
    return { x: base.x + wobble, y: base.y + amplitude * 0.7 * Math.sin((2 * Math.PI * hz * 1.31 * t) / 1000 + 1) }
  }

// ---------------------------------------------------------------------------------------------------------
// The scenarios. Every one of them is something a hand does, and each is here because it asks the guess a
// question the others do not. The assertions live in the test files; this list is what both they and the
// scoreboard iterate.
// ---------------------------------------------------------------------------------------------------------

export type Scenario = {
  name: string
  path: Path
  durationMs: number
  scoreAfterMs?: number
  /** What this one is asking, in a line, so a failure names the case rather than a number. */
  note: string
}

const scenario = (name: string, note: string, path: Path, durationMs: number, scoreAfterMs?: number): Scenario => ({
  name,
  note,
  path,
  durationMs,
  scoreAfterMs,
})

export const SCENARIOS: readonly Scenario[] = [
  scenario('steady fast', 'a hand crossing the pad at speed, off-axis so the counts zig-zag', steady(0.8, 30), 2500),
  scenario('steady slow', 'slow enough that the fit is mostly reading quantisation', steady(0.15, 30), 2500),
  scenario('crawl', 'below the speed gate, where the only honest answer is no lead at all', steady(0.06, 30), 4000),
  scenario(
    'steady on-axis',
    'the same drag with one axis idle, which is where a 2D fit can go wrong',
    steady(0.8, 0),
    2500,
  ),
  scenario('whip', 'far past what the cap allows, so what is being judged is the ceiling', steady(4, 15), 2000),
  scenario(
    'ramp up',
    'constant acceleration from rest: the half of a movement a velocity estimator is late on',
    piecewise([hold(300), accelerate(0.0025, 25, 1200), glide(3, 25, 600)]),
    2100,
    400,
  ),
  scenario(
    'flick, snapped stop',
    'thrown and let go in 80ms — the least warning a stop ever gives',
    flick(2.6, 20, 800, 80),
    1180,
  ),
  scenario('flick, eased stop', 'letting go of a long drag over 250ms', flick(2.6, 20, 800, 250), 1350),
  scenario(
    'abrupt stop',
    'full speed to nothing between two samples, which no fit can see coming',
    piecewise([glide(2, 40, 900), hold(500)]),
    1400,
  ),
  scenario(
    'abrupt start',
    'nothing to full speed between two samples: the guess has to arrive without inventing motion first',
    piecewise([hold(500), glide(2, 40, 900)]),
    1400,
    520,
  ),
  scenario(
    'stop and go',
    'repeated bursts with pauses between them, so every stop is followed by a start',
    piecewise([
      hold(200),
      ...Array.from({ length: 6 }, () => [
        easeUp(1.6, 15, 60),
        glide(1.6, 15, 140),
        easeDown(1.6, 15, 60),
        hold(150),
      ]).flat(),
    ]),
    2700,
    300,
  ),
  scenario(
    'point to point',
    'a deliberate move that starts and ends at rest, twice over',
    piecewise([
      hold(200),
      smoothMove(400, 10, 500),
      hold(300),
      smoothMove(250, 190, 400),
      hold(300),
      smoothMove(600, 70, 700),
      hold(300),
    ]),
    2700,
    300,
  ),
  scenario(
    'sharp corner',
    'a right angle at full speed with no slowing: the heading inverts on one axis and holds on the other',
    piecewise([glide(1.2, 0, 900), glide(1.2, 90, 900)]),
    1800,
  ),
  scenario(
    'rounded corner',
    'the same corner taken round a radius, which is what a hand actually does',
    piecewise([glide(1.2, 0, 900), arc(1.2, 140, 90, 0), glide(1.2, 90, 700)]),
    1900,
  ),
  scenario('circle', 'a hand going round, where a per-axis fit reads a stop twice a lap', circle(120, 400), 3000),
  scenario(
    'circle, tight and fast',
    'the same, wound up until the turn rate is most of the answer',
    circle(60, 260),
    2500,
  ),
  scenario(
    'stir',
    'a small circle fast enough that a whole horizon of turning is past a right angle',
    circle(25, 110),
    2500,
  ),
  scenario('circle, reversed', 'and the other way round, so a turn sign error cannot hide', circle(120, 400, -1), 3000),
  scenario(
    'figure eight',
    'curvature that reverses smoothly, with the hand neither slowing nor turning back',
    figureEight(150, 900),
    3200,
  ),
  scenario(
    'spiral',
    'turning and speeding up at once, which are the two things read off the same window',
    spiral(30, 0.09, 700),
    3000,
  ),
  scenario(
    'serpentine',
    'advancing while weaving, the way a hand tracks something moving',
    serpentine(0.7, 20, 60, 500),
    3000,
  ),
  scenario(
    'zigzag',
    'constant speed with instantaneous reversals: no curvature warns of the turn',
    zigzag(0.9, 35, 260),
    3000,
  ),
  scenario('shake, 8Hz', 'a hand settling on a target — it turns round before the horizon is out', shake(20, 8), 2500),
  scenario(
    'shake, fast and small',
    'the same, quicker and tighter, which is the worst case for it',
    shake(10, 12),
    2500,
  ),
  scenario(
    'overshoot and correct',
    'past the target at speed, then back onto it slowly: a real reversal after a real flick',
    piecewise([
      hold(200),
      easeUp(1.8, 0, 120),
      glide(1.8, 0, 300),
      easeDown(1.8, 0, 160),
      hold(120),
      smoothMove(70, 180, 400),
      hold(400),
    ]),
    1900,
    300,
  ),
  scenario(
    'target acquire',
    'the two phases of aiming: most of the distance fast, the last of it in micro-adjustments',
    piecewise([
      hold(200),
      easeUp(2.2, 12, 100),
      glide(2.2, 12, 260),
      easeDown(2.2, 12, 140),
      hold(80),
      smoothMove(24, 12, 220),
      hold(60),
      smoothMove(9, 192, 180),
      hold(60),
      smoothMove(4, 12, 160),
      hold(500),
    ]),
    2100,
    300,
  ),
  scenario(
    'wide slow arc',
    'a turn gentle enough to sit near the floor the turn rate is believed against',
    piecewise([glide(0.35, 0, 400), arc(0.35, 900, 120, 0), glide(0.35, 120, 400)]),
    3300,
  ),
  scenario(
    'double flick',
    'a second throw before the first has finished stopping, which is where a brake read early has to let go',
    piecewise([
      hold(200),
      easeUp(2.4, 30, 90),
      glide(2.4, 30, 220),
      easeDown(2.4, 30, 110),
      hold(70),
      easeUp(2.4, 45, 90),
      glide(2.4, 45, 260),
      easeDown(2.4, 45, 140),
      hold(400),
    ]),
    1900,
    300,
  ),
  scenario(
    'tremor on a drag',
    'a steady hand is not a still one, and the wobble is the size of the counts underneath it',
    withTremor(steady(0.35, 25), 1.2, 9),
    2500,
  ),
  scenario(
    'tremor at rest',
    'a hand resting on the mouse, which must not be led anywhere at all',
    withTremor(steady(0.004, 25), 0.9, 7),
    2500,
  ),
]
