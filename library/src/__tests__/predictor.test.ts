import { beforeEach, describe, expect, test } from 'bun:test'

import { createPointerPredictor, DEFAULT_MAX_LEAD_PX, DEFAULT_DECAY_MS, DEFAULT_LEAD_FRAMES } from '../predictor.js'

const FRAME = 16.7
// Track what ships, so the floor is the floor of the thing that ships.
const LEAD_FRAMES = DEFAULT_LEAD_FRAMES
const DECAY = 20
const CAP = 40
const SAMPLES_PER_FRAME = 16 // a 1000Hz mouse, which is what puts several samples in one frame
const AGE = 13 // what the newest sample's age measures at at 60Hz, per the example rig

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
// Breaking each part of the predictor in turn fails something here, with one exception worth knowing
// about: CURVE_TRUST_MS can be set to nothing and every figure below stays put. It settles how far the
// curve is believed, which also decides how hard the lead is smoothed, and left unsettled that judgement
// flips frame to frame and the smoothing switches on and off with it. The synthetic hands here move too
// perfectly for the bend to cross its noise floor, so they never produce the flicker. It was found by hand
// on a Bluetooth mouse and confirmed by removing it twice. Do not read its lack of a test as it having no
// job.
describe('pointer prediction quality floor', () => {
  // How many refreshes after a frame is drawn it reaches the screen. No clock inside a page can see this,
  // which is why the example rig exists — so it is an assumption, and the lead is set to match it. Tying
  // the two together is the point: the guess is judged against the pipeline it is aimed at, and if the rig
  // says that pipeline is a different depth, both move and these figures are re-measured.
  const PRESENT_FRAMES = DEFAULT_LEAD_FRAMES

  /** How a device reports: how often, how many at a time, and how much its clock wanders. */
  type Device = { periodMs: number; burst: number; jitterMs: number }
  const WIRED: Device = { periodMs: 1, burst: 1, jitterMs: 0.1 }
  const TRACKPAD: Device = { periodMs: 11, burst: 1, jitterMs: 0.4 }
  // A mouse on a radio: reports in clumps, and says nothing at all for a third of frames while moving.
  const BLUETOOTH: Device = { periodMs: 8, burst: 3, jitterMs: 2.5 }
  // Slower still, and the one whose gaps most resemble a hand that has stopped.
  const SLOW_RADIO: Device = { periodMs: 16, burst: 2, jitterMs: 3 }

  /** `hitchEvery` stalls one frame in that many to three times its length, as a real one does. */
  const replay = (
    path: (t: number) => { x: number; y: number },
    device: Device,
    durationMs: number,
    hitchEvery = 0,
  ) => {
    const predictor = createPointerPredictor()
    let seed = 20260808
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

    let reportedX = 0
    let reportedY = 0
    let integratedX = 0
    let integratedY = 0
    let frameAt = 0
    let prevFrameAt = 0
    let nextReport = 0
    let previous: { x: number; y: number } | null = null
    // What a caller applying only the growth accumulates. Jitter is rectified into rotation there: every
    // upward wobble is kept and none of the downward ones give it back.
    let keptX = 0
    let keptY = 0
    let appliedX = 0
    let appliedY = 0
    let worstStep = 0
    let worstLead = 0
    let radialSum = 0
    let withSum = 0
    let withoutSum = 0
    let scored = 0

    let frameIndex = 0
    while (frameAt <= durationMs) {
      frameIndex++
      frameAt += FRAME * (hitchEvery > 0 && frameIndex % hitchEvery === 0 ? 3 : 1)
      // Events are held until shortly before the callback, and arrive a burst at a time.
      while (nextReport <= frameAt - 2) {
        for (let b = 0; b < device.burst; b++) {
          const t = nextReport - (device.burst - 1 - b) * device.periodMs + (rnd() - 0.5) * device.jitterMs
          if (t <= 0) continue
          const at = path(t)
          // Whole mouse counts, as a real device reports.
          const dx = Math.trunc(at.x) - reportedX
          const dy = Math.trunc(at.y) - reportedY
          if (dx !== 0 || dy !== 0) {
            predictor.push(t, dx, dy)
            reportedX += dx
            reportedY += dy
            integratedX += dx
            integratedY += dy
          }
        }
        nextReport += device.periodMs * device.burst
      }

      const lead = predictor.update({
        nowMs: frameAt,
        deltaMs: frameAt - prevFrameAt,
        leadFrames: LEAD_FRAMES,
        decayMs: DEFAULT_DECAY_MS,
        maxLeadPx: DEFAULT_MAX_LEAD_PX,
      })
      prevFrameAt = frameAt

      const growth = (value: number, applied: number) =>
        value * applied >= 0 && Math.abs(value) > Math.abs(applied) ? value - applied : 0
      keptX += growth(lead.x, appliedX)
      keptY += growth(lead.y, appliedY)
      appliedX = lead.x
      appliedY = lead.y

      // Once the window is full of the motion rather than of starting up.
      if (frameAt > 600) {
        if (previous) worstStep = Math.max(worstStep, Math.hypot(lead.x - previous.x, lead.y - previous.y))
        const truth = path(frameAt + PRESENT_FRAMES * FRAME)
        withSum += (integratedX + lead.x - truth.x) ** 2 + (integratedY + lead.y - truth.y) ** 2
        withoutSum += (integratedX - truth.x) ** 2 + (integratedY - truth.y) ** 2
        radialSum += Math.hypot(integratedX + lead.x, integratedY + lead.y)
        worstLead = Math.max(worstLead, Math.hypot(lead.x, lead.y))
        scored++
      }
      previous = { x: lead.x, y: lead.y }
    }

    return {
      worstStep,
      error: Math.sqrt(withSum / Math.max(1, scored)),
      errorWithout: Math.sqrt(withoutSum / Math.max(1, scored)),
      meanRadius: radialSum / Math.max(1, scored),
      kept: Math.hypot(keptX, keptY),
      worstLead,
    }
  }

  const steady = (speed: number, angleDeg: number) => (t: number) => ({
    x: speed * Math.cos((angleDeg * Math.PI) / 180) * t,
    y: speed * Math.sin((angleDeg * Math.PI) / 180) * t,
  })
  const shake = (amplitude: number, hz: number) => (t: number) => ({
    x: amplitude * Math.sin((2 * Math.PI * hz * t) / 1000),
    y: 0,
  })
  const circle = (r: number, periodMs: number) => (t: number) => ({
    x: r * Math.cos((2 * Math.PI * t) / periodMs),
    y: r * Math.sin((2 * Math.PI * t) / periodMs),
  })

  // A diagonal is the hard case for steadiness: the two axes cross their whole-count boundaries at
  // different moments, so the path the fit sees zig-zags about the true line.
  test('a wired mouse on a steady diagonal barely moves the lead at all', () => {
    expect(replay(steady(0.8, 30), WIRED, 2500).worstStep).toBeLessThan(0.15)
  })

  test('a trackpad on a steady diagonal is nearly as steady as a wired mouse', () => {
    expect(replay(steady(0.8, 30), TRACKPAD, 2500).worstStep).toBeLessThan(0.4)
  })

  test('a mouse on a radio is within reach of the other two', () => {
    // It reports a fifth as often and in clumps, so it will never match them; it must stay close enough
    // that no device makes the camera shake.
    expect(replay(steady(0.8, 30), BLUETOOTH, 2500).worstStep).toBeLessThan(0.9)
    expect(replay(steady(0.8, 30), SLOW_RADIO, 2500).worstStep).toBeLessThan(0.8)
  })

  test('slow motion is steady on every device, which is where a shaky guess shows most', () => {
    for (const device of [WIRED, TRACKPAD, BLUETOOTH, SLOW_RADIO]) {
      expect(replay(steady(0.15, 30), device, 2500).worstStep).toBeLessThan(0.35)
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
      const { kept } = replay(steady(speed, 30), device, 4000)
      const oneLead = speed * (13 + LEAD_FRAMES * FRAME)
      expect(kept).toBeLessThan(oneLead * 0.6)
    }
  })

  test('a stalling frame clock does not throw the lead about', () => {
    // A three-frame stall at 60Hz is 50ms, which is close enough to a plausible refresh interval to be
    // taken for one. Believing it moves the horizon by two frames and hands over pixels of lead on the
    // frame after every stall.
    for (const device of [WIRED, TRACKPAD, BLUETOOTH]) {
      expect(replay(steady(0.8, 30), device, 3000, 20).worstStep).toBeLessThan(1.15)
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
      const { worstLead, error, errorWithout } = replay(shake(amplitude, hz), WIRED, 2500)
      // Never further out than the motion itself is wide.
      expect(worstLead).toBeLessThan(amplitude * 0.6)
      // And guessing must not be worse than not guessing by more than a little.
      expect(error).toBeLessThan(errorWithout * 1.3)
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
      const { meanRadius } = replay(circle(r, periodMs), WIRED, 3000)
      expect(meanRadius - r).toBeLessThan(tolerance)
      expect(meanRadius - r).toBeGreaterThan(-tolerance)
    }
  })

  test('guessing beats not guessing, on every device and both kinds of path', () => {
    for (const device of [WIRED, TRACKPAD, BLUETOOTH, SLOW_RADIO]) {
      const straight = replay(steady(0.8, 30), device, 2500)
      expect(straight.error).toBeLessThan(straight.errorWithout * 0.35)

      const round = replay(circle(120, 400), device, 3000)
      expect(round.error).toBeLessThan(round.errorWithout * 0.75)
    }
  })
})
