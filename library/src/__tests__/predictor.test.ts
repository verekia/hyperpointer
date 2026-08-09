import { beforeEach, describe, expect, test } from 'bun:test'

import { createPointerPredictor, DEFAULT_MAX_LEAD_PX, DEFAULT_DECAY_MS, DEFAULT_LEAD_FRAMES } from '../predictor.js'
import { AGE, BLUETOOTH, circle, FRAME, flick, replay, shake, SLOW_RADIO, steady, TRACKPAD, WIRED } from './harness.js'

// Track what ships, so the floor is the floor of the thing that ships.
const LEAD_FRAMES = DEFAULT_LEAD_FRAMES
const DECAY = 20
const CAP = 40
const SAMPLES_PER_FRAME = 16 // a 1000Hz mouse, which is what puts several samples in one frame

describe('pointer prediction', () => {
  let predictor = createPointerPredictor()
  let now = 1000

  beforeEach(() => {
    predictor = createPointerPredictor()
    now = 1000
  })

  // Advances one frame, feeding `pxPerFrame` along X spread evenly over the samples of that frame. They
  // end AGE before the frame reads them, because the browser holds move events until just before the
  // callback. Returns the X lead, which is the one the camera applies.
  const frame = (pxPerFrame: number, opts: { leadFrames?: number; cap?: number; decay?: number } = {}) => {
    if (pxPerFrame !== 0) {
      for (let i = 1; i <= SAMPLES_PER_FRAME; i++) {
        predictor.push(now - AGE - FRAME + (i * FRAME) / SAMPLES_PER_FRAME, pxPerFrame / SAMPLES_PER_FRAME, 0)
      }
    }
    const lead = predictor.update({
      nowMs: now,
      deltaMs: FRAME,
      leadFrames: opts.leadFrames ?? LEAD_FRAMES,
      decayMs: opts.decay ?? DECAY,
      maxLeadPx: opts.cap ?? CAP,
    }).x
    now += FRAME
    return lead
  }

  test('leads in the direction of travel once the motion is established', () => {
    let lead = 0
    for (let i = 0; i < 10; i++) lead = frame(10)
    expect(lead).toBeGreaterThan(0)
  })

  test('a stopped mouse fades the lead to nothing instead of sailing on', () => {
    for (let i = 0; i < 10; i++) frame(10)

    // Silence is the only signal the pointer stopped, and the lead must not grow while it lasts.
    const first = frame(0)
    const second = frame(0)
    expect(second).toBeLessThan(first)

    // It eases out rather than dropping, and settles at exactly zero rather than creeping.
    let last = second
    for (let i = 0; i < 60; i++) last = frame(0)
    expect(last).toBe(0)
  })

  test('a pause before a flick does not buy the flick a longer stop', () => {
    // How long a device stays quiet while the hand is still moving has to be learned, because a mouse on a
    // radio says nothing for twenty milliseconds at a time mid-flick and reading that as a stop makes the
    // lead flicker. What is far too easy to learn by mistake is the hand sitting still: that silence looks
    // exactly the same and is many times longer, and taken for a property of the device it says this one
    // reports three times a second.
    //
    // Every pause the user makes then buys the flick after it that much longer before its stop is noticed,
    // and the lead goes on growing over a hand that is already still — a quarter-second pause was worth
    // 45px of travel the hand never made, and 23 frames of it. So the same flick has to end the same way
    // however long the hand sat before it started.
    const sail = (idleFrames: number) => {
      predictor = createPointerPredictor()
      now = 1000
      // The shipped ramp and ceiling, not this file's shorter ones: how far a stop sails depends on both,
      // so the figures below only mean anything against what the camera actually uses.
      const shipped = { decay: DEFAULT_DECAY_MS, cap: DEFAULT_MAX_LEAD_PX }
      for (let i = 0; i < idleFrames; i++) frame(0, shipped)

      let atStop = 0
      for (let i = 0; i < 8; i++) atStop = frame(42, shipped)

      let grew = 0
      let previous = atStop
      let frames = 0
      for (let i = 0; i < 40; i++) {
        const lead = frame(0, shipped)
        grew += Math.max(0, lead - previous)
        previous = lead
        if (Math.abs(lead) > Math.abs(atStop) * 0.1) frames = i + 1
      }
      return { grew, frames }
    }

    const unpaused = sail(0)
    // A flick straight off a standing start barely sails at all, and is done inside a tenth of a second.
    expect(unpaused.grew).toBeLessThan(6)
    expect(unpaused.frames).toBeLessThan(7)

    // And no amount of sitting still first changes that.
    for (const idleFrames of [3, 10, 30, 90]) {
      const paused = sail(idleFrames)
      expect(paused.grew).toBeLessThanOrEqual(unpaused.grew + 0.5)
      expect(paused.frames).toBeLessThanOrEqual(unpaused.frames)
    }
  })

  test('a frame that carries no samples at all does not grow the guess', () => {
    // Measured on a trackpad, which hands over exactly one coalesced sample per frame — so the window
    // behind the fit is three points wide and every frame is either all of the motion or none of it. The
    // travel below is what that device actually reported into a fast flick, in pixels per frame.
    //
    // When the hand came off the pad, the very next frame carried no samples and no motion, and the lead
    // still grew from 47 to 56px on it: a fifth of the guess invented by a frame that learned nothing. It
    // is also the only frame the eye gets, because the one after it is already being discounted — so this
    // single frame was the whole visible artefact.
    //
    // Freshness cannot catch it. It does not begin to fade until a full frame of silence has passed, and
    // one frame is all it takes.
    // One sample a frame rather than the sixteen `frame` feeds, which is the whole point of this case.
    const step = (movedPx: number) => {
      if (movedPx > 0) predictor.push(now - AGE, movedPx, 0)
      const lead = predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        decayMs: DEFAULT_DECAY_MS,
        maxLeadPx: DEFAULT_MAX_LEAD_PX,
      })
      now += FRAME
      return lead
    }

    let moving = 0
    for (const movedPx of [9, 61, 116, 283, 317]) moving = step(movedPx).x
    expect(moving).toBeGreaterThan(20)

    // It may hold what it has, and it may fade. It may not go further out on nothing at all.
    const silent = step(0)
    expect(silent.x).toBeLessThanOrEqual(moving)
    // And it must still be live: dropping the guess outright on one empty frame is what a device that
    // leaves a third of its frames empty while moving cannot survive.
    expect(silent.live).toBeGreaterThan(0)
  })

  test('the fit reads the deceleration, so the lead is coming down before the hand stops', () => {
    // A flick that eases out, at frame resolution. This is the whole reason for fitting a curve rather
    // than smoothing a velocity: an estimator that cannot see a stop coming is still at about 90% of its
    // peak when the hand is already still.
    //
    // The margin here is not the ~20% the bare fit manages, because how far the curve is believed is
    // settled over CURVE_TRUST_MS rather than answered afresh each frame, which delays the curvature that
    // reads the deceleration. That is a deliberate trade: the same settling is what stops the smoothing
    // switching on and off on a device whose bend sits near its own noise floor, which is worth more on a
    // camera than a sharper stop is.
    const speeds = [0.7, 2.6, 5.3, 8.1, 10.5, 11.8, 11.8, 10.5, 8.1, 5.3, 2.6, 0.7]
    let peak = 0
    let lead = 0
    for (const speed of speeds) {
      lead = frame(speed * FRAME)
      peak = Math.max(peak, Math.abs(lead))
    }
    expect(peak).toBeGreaterThan(20)
    expect(Math.abs(lead)).toBeLessThan(peak * 0.65)
  })

  test('the lead never points against the way the samples say the hand is going', () => {
    // Past the vertex of a fitted parabola the slope inverts, so the tail of a flick asks to be led
    // backwards. That is a visible kick, and no sample supports it.
    const speeds = [2, 6, 10, 12, 10, 6, 2, 0.5, 0.2]
    for (const speed of speeds) expect(frame(speed * FRAME)).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < 5; i++) expect(frame(0)).toBeGreaterThanOrEqual(0)
  })

  test('reversing direction pulls the lead the new way rather than the old', () => {
    for (let i = 0; i < 10; i++) frame(10)
    const before = frame(10)
    expect(before).toBeGreaterThan(0)

    let lead = before
    for (let i = 0; i < 6; i++) lead = frame(-10)
    expect(lead).toBeLessThan(0)
  })

  test('a hard flick is capped instead of leading by a quarter turn', () => {
    let lead = 0
    // 6px/ms is a whip across the pad; uncapped this would ask for hundreds of pixels of lead.
    for (let i = 0; i < 40; i++) lead = frame(6 * FRAME)
    expect(lead).toBeLessThanOrEqual(CAP)
  })

  test('the lead is a number of frames, so a faster display leads for proportionally less time', () => {
    let slow = 0
    for (let i = 0; i < 40; i++) slow = frame(1 * FRAME)

    // Same hand speed in pixels per millisecond, half the frame interval.
    const fastPredictor = createPointerPredictor()
    const fastFrame = FRAME / 2
    let fastNow = 1000
    let fast = 0
    for (let i = 0; i < 80; i++) {
      for (let s = 1; s <= SAMPLES_PER_FRAME; s++) {
        const t = fastNow - AGE - fastFrame + (s * fastFrame) / SAMPLES_PER_FRAME
        fastPredictor.push(t, (1 * fastFrame) / SAMPLES_PER_FRAME, 0)
      }
      fast = fastPredictor.update({
        nowMs: fastNow,
        deltaMs: fastFrame,
        leadFrames: LEAD_FRAMES,
        decayMs: DECAY,
        maxLeadPx: CAP,
      }).x
      fastNow += fastFrame
    }

    expect(fast).toBeLessThan(slow)
  })

  test('a reset drops the window, so returning from a menu cannot apply a stale lead', () => {
    let lead = 0
    for (let i = 0; i < 40; i++) lead = frame(10)
    expect(lead).toBeGreaterThan(0)

    // Whatever held the lead — showroom camera, an unlocked pointer — the next locked frame has to start
    // from nothing rather than fit a curve through motion from before the gap.
    predictor.reset()
    expect(frame(0)).toBe(0)
  })

  test('zero lead predicts nothing while the mouse is moving', () => {
    let lead = 0
    for (let i = 0; i < 10; i++) lead = frame(10, { leadFrames: 0 })

    // Only the time already spent since the newest sample is extrapolated, which is one frame at most.
    expect(Math.abs(lead)).toBeLessThan(10)
  })

  test('a mouse reporting once per frame falls back to a straight line rather than fitting noise', () => {
    // Three samples in the window cannot condition a quadratic. The lead must still point the right way
    // and stay sane rather than blowing up on the curvature of the noise.
    let lead = 0
    for (let i = 0; i < 20; i++) {
      predictor.push(now - AGE, 10, 0)
      lead = predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        decayMs: DECAY,
        maxLeadPx: CAP,
      }).x
      now += FRAME
    }
    expect(lead).toBeGreaterThan(0)
    expect(lead).toBeLessThanOrEqual(CAP)
  })

  test('a crawl is not led, so whole-count noise cannot be mistaken for motion', () => {
    // 0.03px/ms is a slow drag: about one mouse count every 33ms. There is nothing in that a fit can tell
    // apart from quantisation, and the camera keeps every upward wobble it is handed.
    let lead = 0
    let carried = 0
    for (let f = 0; f < 60; f++) {
      const before = Math.floor(0.03 * (now - AGE - FRAME))
      const after = Math.floor(0.03 * (now - AGE))
      for (let c = before; c < after; c++) predictor.push((c + 1) / 0.03 + AGE, 1, 0)
      lead = predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        decayMs: DECAY,
        maxLeadPx: CAP,
      }).x
      carried = Math.max(carried, Math.abs(lead))
      now += FRAME
    }
    expect(carried).toBe(0)
    void lead
  })

  test('a real turn is still led in full', () => {
    // 0.5px/ms, comfortably above the crawl. The gate must not touch it.
    let lead = 0
    for (let i = 0; i < 30; i++) lead = frame(0.5 * FRAME)
    expect(lead).toBeGreaterThan(0.5 * (AGE + LEAD_FRAMES * FRAME) * 0.6)
  })

  test('a circling hand is led along the circle, not off the outside of it', () => {
    // Per axis this is the case that breaks: at the moment X is at its extremum its window travel is zero,
    // so every guard reads a hand that is stopping and cancels exactly the inward part of the guess. The
    // prediction then leaves along the tangent, which is outside the circle.
    const R = 60
    const T = 400
    const w = (2 * Math.PI) / T
    const at = (t: number) => ({ x: R * Math.cos(w * t), y: R * Math.sin(w * t) })

    let reportedX = 0
    let reportedY = 0
    let integratedX = 0
    let integratedY = 0
    let sampleT = 0
    let worstRadial = 0

    for (let f = 0; f < 120; f++) {
      while (sampleT + 1 <= now - AGE) {
        sampleT += 1
        const p = at(sampleT)
        // Whole mouse counts, as a real device reports.
        const dx = Math.trunc(p.x - reportedX)
        const dy = Math.trunc(p.y - reportedY)
        if (dx !== 0 || dy !== 0) {
          predictor.push(sampleT, dx, dy)
          reportedX += dx
          reportedY += dy
          integratedX += dx
          integratedY += dy
        }
      }
      const lead = predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        decayMs: DECAY,
        maxLeadPx: CAP,
      })
      // Half a turn in, the fit has a full window of circle to work from.
      if (f > 30) {
        worstRadial = Math.max(worstRadial, Math.hypot(integratedX + lead.x, integratedY + lead.y) - R)
      }
      now += FRAME
    }

    // A tangential guess over this horizon lands about R*(1/cos(wh) - 1) outside, which is over 20px here.
    // Following the arc has to keep it well inside that.
    expect(worstRadial).toBeLessThan(15)
  })

  test('a steady diagonal gives a steady lead, not a hectic one', () => {
    // Off an axis the two axes cross their whole-count boundaries at different moments, so the path the
    // predictor sees is a zig-zag staircase about the true line. A turn rate and a curvature read straight
    // off that wander far more than any hand does. 30 degrees at 0.3px/ms, which is a medium steady drag.
    const speed = 0.3
    const angle = (30 * Math.PI) / 180
    let reportedX = 0
    let reportedY = 0
    let sampleT = 0
    let previous: { x: number; y: number } | null = null
    let worstStep = 0

    for (let f = 0; f < 120; f++) {
      while (sampleT + 1 <= now - AGE) {
        sampleT += 1
        const dx = Math.trunc(speed * Math.cos(angle) * sampleT - reportedX)
        const dy = Math.trunc(speed * Math.sin(angle) * sampleT - reportedY)
        if (dx !== 0 || dy !== 0) {
          predictor.push(sampleT, dx, dy)
          reportedX += dx
          reportedY += dy
        }
      }
      const lead = predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        // The shipped ramp, not this file's shorter one: how steady the lead is depends on it, so the
        // figure below only means anything against the value the camera actually uses.
        decayMs: DEFAULT_DECAY_MS,
        maxLeadPx: CAP,
      })
      // Once the window is full of the drag, the hand is perfectly steady and so should the lead be.
      if (f > 40 && previous) {
        worstStep = Math.max(worstStep, Math.hypot(lead.x - previous.x, lead.y - previous.y))
      }
      previous = { x: lead.x, y: lead.y }
      now += FRAME
    }

    // The lead here is about 10px. Untrimmed noise moved it by 2.4px in a single frame.
    expect(worstStep).toBeLessThan(1)
  })

  test('a wandering frame clock does not shake the lead', () => {
    // Frames do not land on an exact grid and the browser does not hand the events over at a fixed offset,
    // so the age of the newest sample wanders by a few milliseconds every frame. It goes straight into the
    // horizon, and at speed a few milliseconds of horizon is pixels of lead on a hand doing nothing new.
    const speed = 0.8
    let reported = 0
    let vsync = 1000
    let previousFrame = 1000
    let delivered = 1000
    let previous: number | null = null
    let worstStep = 0
    let wobble = 0

    for (let f = 0; f < 150; f++) {
      // A deterministic wander, and every third frame is a long one.
      wobble = (wobble * 37 + 11) % 13
      vsync += FRAME * (f % 31 === 30 ? 3 : 1)
      const frameAt = vsync + (wobble / 13 - 0.5) * 3
      const deliverUntil = frameAt - 2 - (wobble / 13) * 5

      while (delivered + 1 <= deliverUntil) {
        delivered += 1
        const want = Math.trunc(speed * delivered - reported)
        if (want !== 0) {
          predictor.push(delivered, want, 0)
          reported += want
        }
      }

      const lead = predictor.update({
        nowMs: frameAt,
        deltaMs: frameAt - previousFrame,
        leadFrames: LEAD_FRAMES,
        decayMs: DEFAULT_DECAY_MS,
        maxLeadPx: CAP,
      }).x
      previousFrame = frameAt
      if (f > 60 && previous !== null) worstStep = Math.max(worstStep, Math.abs(lead - previous))
      previous = lead
    }

    // The lead here runs about 30px. Reading the age and the frame interval raw moved it 4px in a frame.
    expect(worstStep).toBeLessThan(2)
  })

  test('a device that reports in bursts is as steady as one that reports every millisecond', () => {
    // A mouse on a radio reports about eight times a frame's worth of time apart, in clumps, and goes
    // quiet in between. Reading that quiet as a stopped hand scaled the lead down on every frame that
    // landed between bursts and back up on the next one, and a window holding five samples cannot carry a
    // curve. Both had to stop mattering before this device read as steadily as a wired one.
    const speed = 0.5
    const angle = (30 * Math.PI) / 180
    let reportedX = 0
    let reportedY = 0
    let nextReport = now - AGE
    let previous: { x: number; y: number } | null = null
    let worstStep = 0

    for (let f = 0; f < 150; f++) {
      // Two reports at a time, 8ms apart, arriving every 16ms — so a third of frames see nothing at all.
      while (nextReport <= now - AGE) {
        for (const t of [nextReport - 8, nextReport]) {
          const dx = Math.trunc(speed * Math.cos(angle) * t) - reportedX
          const dy = Math.trunc(speed * Math.sin(angle) * t) - reportedY
          if (dx !== 0 || dy !== 0) {
            predictor.push(t, dx, dy)
            reportedX += dx
            reportedY += dy
          }
        }
        nextReport += 16
      }

      const lead = predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        decayMs: DEFAULT_DECAY_MS,
        maxLeadPx: CAP,
      })
      if (f > 40 && previous) {
        worstStep = Math.max(worstStep, Math.hypot(lead.x - previous.x, lead.y - previous.y))
      }
      previous = { x: lead.x, y: lead.y }
      now += FRAME
    }

    // The lead runs about 17px. Treating the gaps between bursts as a stop moved it by 6px in a frame.
    expect(worstStep).toBeLessThan(1)
  })

  test('integer counts do not make the curve fit blow up', () => {
    // A real mouse reports whole counts. A quadratic differentiates twice, so quantisation noise is the
    // thing most likely to wreck it. 8px a frame is about 0.5px/ms, worth ~20px over the horizon.
    let lead = 0
    for (let i = 0; i < 40; i++) {
      for (let s = 0; s < SAMPLES_PER_FRAME; s++) {
        predictor.push(now - AGE - FRAME + s, s % 2 === 0 ? 1 : 0, 0)
      }
      lead = predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        decayMs: DECAY,
        maxLeadPx: CAP,
      }).x
      now += FRAME
    }
    // 8px per frame is about 0.5px/ms, so ~46ms of horizon is worth ~20px. Nowhere near the cap.
    expect(lead).toBeGreaterThan(0)
    expect(lead).toBeLessThan(CAP)
  })
})

// The floor of what this is expected to deliver, in the numbers it is actually judged by. Every figure
// here was measured, then given room; they are not aspirations. A change that makes the guess shakier or
// lazier should fail here rather than be noticed on somebody's desk weeks later — and one that improves
// on them should tighten them, because a floor nobody lowers stops being a floor.
//
// Smoothness is the frame-to-frame move of the lead on a hand doing nothing new: since the hand is not
// changing, every bit of it is jitter, and jitter on a camera is nauseating. Accuracy is scored against
// where the hand really is when the frame reaches the screen, and has to beat not guessing at all.
//
// This file is the original floor and stays as the shortest description of what the predictor owes. The
// broad sweep lives next door — `predictor-shapes`, `predictor-stops`, `predictor-devices` and
// `predictor-invariants`, all replayed through `harness.ts`, which is also what `bun run bench` prints.
//
// Every constant in `predictor.ts` was broken in turn against the whole suite and every one of them fails
// something, which is the property worth keeping as it grows. Two lines are not reached by any hand that
// can be modelled here, and are worth knowing about rather than testing for the sake of it:
//
//   - `MAX_TURN_RAD`, which clamps how far one horizon of arc may sweep. By the time the turn rate has been
//     through its own noise gate, a hand would have to be circling faster than nine revolutions a second to
//     reach it. It is a guard against a fit that has run away, not against a hand.
//   - The horizon being cut short at the point the fit says the hand stops. Past that point the distance is
//     already floored at zero, so removing the cut moves nothing measurably.
//
// CURVE_TRUST_MS used to be a third: the synthetic hands in this file move too perfectly for the bend to
// sit near its noise floor, which is the flicker it exists to stop. The tremor and coarse-count cases next
// door do produce it, so setting it to nothing now fails seventeen tests.
describe('pointer prediction quality floor', () => {
  // A diagonal is the hard case for steadiness: the two axes cross their whole-count boundaries at
  // different moments, so the path the fit sees zig-zags about the true line.
  test('a wired mouse on a steady diagonal barely moves the lead at all', () => {
    expect(replay({ path: steady(0.8, 30), device: WIRED, durationMs: 2500 }).worstStep).toBeLessThan(0.15)
  })

  test('a trackpad on a steady diagonal is nearly as steady as a wired mouse', () => {
    expect(replay({ path: steady(0.8, 30), device: TRACKPAD, durationMs: 2500 }).worstStep).toBeLessThan(0.4)
  })

  test('a mouse on a radio is within reach of the other two', () => {
    // It reports a fifth as often and in clumps, so it will never match them; it must stay close enough
    // that no device makes the camera shake.
    expect(replay({ path: steady(0.8, 30), device: BLUETOOTH, durationMs: 2500 }).worstStep).toBeLessThan(0.9)
    expect(replay({ path: steady(0.8, 30), device: SLOW_RADIO, durationMs: 2500 }).worstStep).toBeLessThan(0.8)
  })

  test('slow motion is steady on every device, which is where a shaky guess shows most', () => {
    for (const device of [WIRED, TRACKPAD, BLUETOOTH, SLOW_RADIO]) {
      expect(replay({ path: steady(0.15, 30), device, durationMs: 2500 }).worstStep).toBeLessThan(0.35)
    }
  })

  test('a window too thin to extrapolate from produces no guess, whatever the cap', () => {
    // Coalesced samples can arrive a fraction of a millisecond apart. A velocity read off two of those is
    // enormous and means nothing, and the horizon it would be extrapolated over is tens of milliseconds.
    // maxLeadPx is the caller's feel setting and must not be what stands between that and the camera, so
    // this asks with no ceiling at all.
    const uncapped = { leadFrames: LEAD_FRAMES, decayMs: DEFAULT_DECAY_MS, maxLeadPx: Number.MAX_SAFE_INTEGER }

    const sliver = createPointerPredictor()
    sliver.push(1000, 3, 0)
    sliver.push(1000.001, 3, 0)
    expect(sliver.update({ nowMs: 1013, deltaMs: FRAME, ...uncapped }).x).toBe(0)

    const sameInstant = createPointerPredictor()
    for (let i = 0; i < 40; i++) sameInstant.push(1000, 5, 5)
    expect(sameInstant.update({ nowMs: 1013, deltaMs: FRAME, ...uncapped }).x).toBe(0)

    const backwards = createPointerPredictor()
    for (let i = 0; i < 40; i++) backwards.push(1000 - i * 0.5, 5, 0)
    const lead = backwards.update({ nowMs: 1013, deltaMs: FRAME, ...uncapped })
    expect(Number.isFinite(lead.x)).toBe(true)
    expect(Math.abs(lead.x)).toBeLessThan(100)
  })

  test('a stopped hand fades at the ordinary rate, not the smoothed-down one', () => {
    // The ramp is lengthened when the window behind a guess is thin, which is right while a guess is being
    // made and wrong once there is none: a frame that produces nothing must not be left holding the last
    // confidence, or every stop after slow motion fades several times too slowly.
    const predictor = createPointerPredictor()
    let reported = 0
    let t = 0
    let now = 1000

    // Slow motion, which is where confidence is lowest and the ramp longest.
    for (let f = 0; f < 60; f++) {
      while (t + 1 <= now - AGE) {
        t += 1
        const dx = Math.trunc(0.3 * t) - reported
        if (dx !== 0) {
          predictor.push(t, dx, 0)
          reported += dx
        }
      }
      predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        decayMs: DEFAULT_DECAY_MS,
        maxLeadPx: DEFAULT_MAX_LEAD_PX,
      })
      now += FRAME
    }

    let peak = 0
    let frames = 0
    for (let f = 0; f < 40; f++) {
      const lead = predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        decayMs: DEFAULT_DECAY_MS,
        maxLeadPx: DEFAULT_MAX_LEAD_PX,
      })
      now += FRAME
      peak = Math.max(peak, Math.abs(lead.x))
      if (Math.abs(lead.x) > peak * 0.1) frames = f + 1
    }
    expect(peak).toBeGreaterThan(2)
    // About a tenth of a second. Holding a stale confidence stretches this to nearer half of one.
    expect(frames).toBeLessThan(8)
  })

  test('a lead left over from a turn fades without going on turning', () => {
    // The lead is carried around by the turn the path is believed to have, which is what keeps it pointing
    // along an arc rather than trailing the heading. A frame that produces no guess at all must not be
    // left holding the last one's turn, or a hand that stops mid-circle leaves a lead that goes on
    // rotating after the hand has not.
    const predictor = createPointerPredictor()
    const r = 120
    const periodMs = 300
    let reportedX = 0
    let reportedY = 0
    let t = 0
    let now = 1000

    // Round the circle for long enough to establish a turn.
    for (let f = 0; f < 60; f++) {
      while (t + 1 <= now - AGE) {
        t += 1
        const dx = Math.trunc(r * Math.cos((2 * Math.PI * t) / periodMs)) - reportedX
        const dy = Math.trunc(r * Math.sin((2 * Math.PI * t) / periodMs)) - reportedY
        if (dx !== 0 || dy !== 0) {
          predictor.push(t, dx, dy)
          reportedX += dx
          reportedY += dy
        }
      }
      predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        decayMs: DEFAULT_DECAY_MS,
        maxLeadPx: DEFAULT_MAX_LEAD_PX,
      })
      now += FRAME
    }

    // Then the hand stops dead: no more samples at all.
    let swept = 0
    let previousAngle: number | null = null
    for (let f = 0; f < 20; f++) {
      const lead = predictor.update({
        nowMs: now,
        deltaMs: FRAME,
        leadFrames: LEAD_FRAMES,
        decayMs: DEFAULT_DECAY_MS,
        maxLeadPx: DEFAULT_MAX_LEAD_PX,
      })
      now += FRAME
      if (Math.hypot(lead.x, lead.y) < 1) break
      const angle = Math.atan2(lead.y, lead.x)
      if (previousAngle !== null) {
        let step = angle - previousAngle
        while (step > Math.PI) step -= 2 * Math.PI
        while (step < -Math.PI) step += 2 * Math.PI
        swept += Math.abs(step)
      }
      previousAngle = angle
    }

    // Carrying a stale turn through the fade sweeps most of a revolution. Fading in place sweeps nothing.
    // Carrying a stale turn through the fade sweeps 2.6 radians. Fading in place sweeps about 0.2, which
    // is what is left of the guess still being made for a frame or two as freshness runs out.
    expect(swept).toBeLessThan(0.8)
  })

  test('a slow steady drag is not turned into rotation that keeps accumulating', () => {
    // A caller applying only the growth keeps every upward wobble and gives none of them back, so noise on
    // a slow hand becomes rotation for as long as the drag lasts rather than one lead's worth of it. Over
    // four seconds at a crawl this used to reach nearly four times the lead it should have left behind.
    for (const device of [WIRED, TRACKPAD, BLUETOOTH, SLOW_RADIO]) {
      const speed = 0.06
      const { kept } = replay({ path: steady(speed, 30), device, durationMs: 4000 })
      const oneLead = speed * (13 + LEAD_FRAMES * FRAME)
      expect(kept).toBeLessThan(oneLead * 0.6)
    }
  })

  test('a stalling frame clock does not throw the lead about', () => {
    // A three-frame stall at 60Hz is 50ms, which is close enough to a plausible refresh interval to be
    // taken for one. Believing it moves the horizon by two frames and hands over pixels of lead on the
    // frame after every stall.
    for (const device of [WIRED, TRACKPAD, BLUETOOTH]) {
      expect(replay({ path: steady(0.8, 30), device, durationMs: 3000, hitchEvery: 20 }).worstStep).toBeLessThan(1.15)
    }
  })

  test('a hand shaking back and forth is not led past its own reversal', () => {
    // Quick and small, the way a hand settling on a target moves. It turns round before the horizon is
    // out, so a guess taken at face value runs straight through a reversal it cannot see — at the moment
    // a shake is fastest there is no acceleration to give it away, the turn still being ahead. Left
    // unbounded the guess ran further than the whole width of the motion.
    for (const [amplitude, hz] of [
      [20, 8],
      [40, 8],
      [10, 12],
    ] as const) {
      const { worstLead, error, errorWithout } = replay({ path: shake(amplitude, hz), device: WIRED, durationMs: 2500 })
      // Never further out than the motion itself is wide. A shake is a stop twice a cycle, so reading the
      // braking sooner pulled both of these in and they were tightened to match.
      expect(worstLead).toBeLessThan(amplitude * 0.55)
      // And guessing must not be worse than not guessing by more than a little.
      expect(error).toBeLessThan(errorWithout * 1.15)
    }
  })

  test('a circling hand is led along the circle rather than off the outside of it', () => {
    // Leading along the tangent instead of the arc puts the guess outside the circle, by more the faster
    // the hand goes round. The mean radius is what catches that: it should stay near the true one.
    // The faster the hand goes round, the more of the guess the cap holds back, and a held-back guess is
    // pulled towards the circle rather than away from it — so a tighter cap flatters this figure while
    // making the guess as a whole worse. These are the margins at the cap that ships.
    for (const [r, periodMs, tolerance] of [
      [60, 400, 3],
      [120, 300, 4],
      [200, 400, 3],
    ] as const) {
      const { meanRadius } = replay({ path: circle(r, periodMs), device: WIRED, durationMs: 3000 })
      expect(meanRadius - r).toBeLessThan(tolerance)
      expect(meanRadius - r).toBeGreaterThan(-tolerance)
    }
  })

  test('a flick that eases out is not led past where the hand stops', () => {
    // The stop is where a guess is most exposed. The hand gives up all its speed in about a tenth of a
    // second, and every reading that could see it coming — the curvature, the trend in the fitted speed,
    // the target's own slope — only exists once the stopping is already under way. Lead still being held
    // by then has to be handed back, and handing it back walks the view backwards under the hand, which
    // is the one error a camera cannot hide.
    //
    // Scored along the way the hand is going and only where the guess is ahead of it, so this is overshoot
    // by itself rather than the ordinary lateness rolled in with it. An 80ms fall is a hand snapping to a
    // halt; 250ms is letting go of a long drag. The slower the device reports, the later it can possibly
    // know, so each is held to its own figure.
    const limits = [
      [WIRED, 26, 12, 6],
      [TRACKPAD, 44, 24, 18],
      [BLUETOOTH, 53, 35, 33],
      [SLOW_RADIO, 57, 45, 40],
    ] as const
    for (const [device, ...allowed] of limits) {
      const falls = [80, 150, 250] as const
      falls.forEach((fallMs, i) => {
        const { worstOvershoot, error, errorWithout } = replay({
          path: flick(2.6, 20, 800, fallMs),
          device,
          durationMs: 800 + fallMs + 300,
        })
        expect(worstOvershoot).toBeLessThan(allowed[i]!)
        // And none of that may be bought by simply not guessing, which would score perfectly here.
        expect(error).toBeLessThan(errorWithout * 0.45)
      })
    }
  })

  test('guessing beats not guessing, on every device and both kinds of path', () => {
    for (const device of [WIRED, TRACKPAD, BLUETOOTH, SLOW_RADIO]) {
      const straight = replay({ path: steady(0.8, 30), device, durationMs: 2500 })
      expect(straight.error).toBeLessThan(straight.errorWithout * 0.35)

      const round = replay({ path: circle(120, 400), device, durationMs: 3000 })
      expect(round.error).toBeLessThan(round.errorWithout * 0.75)
    }
  })
})
