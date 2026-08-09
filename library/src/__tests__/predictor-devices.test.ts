import { describe, expect, test } from 'bun:test'

import { createPointerPredictor, DEFAULT_DECAY_MS, DEFAULT_LEAD_FRAMES, DEFAULT_MAX_LEAD_PX } from '../predictor.js'
import {
  ALL_DEVICES,
  BLUETOOTH,
  COARSE,
  FINE,
  flick,
  glide,
  HZ_120,
  HZ_144,
  HZ_30,
  HZ_60,
  FRAME,
  hold,
  piecewise,
  replay,
  SCENARIOS,
  SPARSE,
  steady,
  TRACKPAD,
  USB_125,
  USB_500,
  WIRED,
} from './harness.js'

// The two axes that are not the hand: what the device does, and what the display does.
//
// The same hand reads completely differently through a wired mouse and through one on a radio, and the whole
// difficulty of the prediction is that there is no telling them apart in advance — the guess has to be
// steady on a device reporting a thousand times a second and on one reporting twenty, without being told
// which it is on. The display axis is the same question about the other end: the lead is a count of
// refreshes because the delay it covers is a count of refreshes, so the same setting has to mean half as
// long on a 120Hz screen and the figures have to hold there too.

const SHIPPED = { leadFrames: DEFAULT_LEAD_FRAMES, decayMs: DEFAULT_DECAY_MS, maxLeadPx: DEFAULT_MAX_LEAD_PX }

describe('every device', () => {
  // How much the size of the guess may jump in one frame, on a hand that is doing nothing new. Measured,
  // then given room. The ordering is the interesting part: it tracks how often the device reports and
  // nothing else — the low-DPI mouse sits with the other devices of its rate rather than thirty times worse
  // than them, which is the whole of what measuring the count size bought.
  const STEADY: Record<string, { fast: number; slow: number; gain: number }> = {
    wired: { fast: 0.05, slow: 0.09, gain: 0.06 },
    '8KHz mouse': { fast: 0.04, slow: 0.07, gain: 0.05 },
    '500Hz mouse': { fast: 0.05, slow: 0.09, gain: 0.07 },
    '125Hz mouse': { fast: 0.2, slow: 0.18, gain: 0.14 },
    trackpad: { fast: 0.23, slow: 0.18, gain: 0.17 },
    bluetooth: { fast: 0.73, slow: 0.25, gain: 0.28 },
    'slow radio': { fast: 0.64, slow: 0.29, gain: 0.36 },
    'low-DPI mouse': { fast: 0.75, slow: 0.65, gain: 0.24 },
    'half-pixel mouse': { fast: 0.06, slow: 0.08, gain: 0.08 },
    sparse: { fast: 0.95, slow: 0.29, gain: 0.29 },
  }

  for (const device of ALL_DEVICES) {
    test(`${device.name}: a steady drag gives a steady lead`, () => {
      const limits = STEADY[device.name]!
      const fast = replay({ path: steady(0.8, 30), device, durationMs: 2500 })
      expect(fast.worstSizeStep).toBeLessThan(limits.fast)
      expect(fast.gain).toBeLessThan(limits.gain)
      // Slow motion is where a shaky guess shows most: the lead is a pixel and a half, so a tenth of a pixel
      // of wobble is a tenth of the whole thing.
      const slow = replay({ path: steady(0.15, 30), device, durationMs: 2500 })
      expect(slow.worstSizeStep).toBeLessThan(limits.slow)
    })
  }

  test('a crawl is led by nothing at all', () => {
    // Below the gate there is nothing in the samples a fit can tell from quantisation, and a caller applying
    // only the growth keeps every upward wobble of it for as long as the drag lasts. Exactly nothing, not
    // nearly nothing.
    for (const device of ALL_DEVICES) {
      if (device === COARSE) continue
      const { worstLead, kept } = replay({ path: steady(0.06, 30), device, durationMs: 4000 })
      expect(worstLead).toBe(0)
      expect(kept).toBe(0)
    }
    // The low-DPI mouse takes about half a second to be recognised as one, and until then its counts are
    // assumed to be pixels and a stray pair of them reads as motion. What it may not do is go on doing that
    // for the rest of the drag.
    const coarse = replay({ path: steady(0.06, 30), device: COARSE, durationMs: 4000 })
    expect(coarse.worstLead).toBeLessThan(2)
    expect(coarse.kept).toBeLessThan(12)
  })

  test('a stalling frame clock does not throw the lead about', () => {
    // A three-frame stall at 60Hz is 50ms, which is close enough to a plausible refresh interval to be taken
    // for one. Believing it moves the horizon by two frames and hands over pixels of lead on the frame after
    // every stall.
    const ALLOWED: Record<string, number> = {
      wired: 0.45,
      '8KHz mouse': 0.35,
      '500Hz mouse': 0.4,
      '125Hz mouse': 0.25,
      trackpad: 0.55,
      bluetooth: 1.2,
      'slow radio': 1.9,
      'low-DPI mouse': 0.8,
      'half-pixel mouse': 0.4,
      sparse: 1.7,
    }
    for (const device of ALL_DEVICES) {
      const { worstSizeStep } = replay({ path: steady(0.8, 30), device, durationMs: 3000, hitchEvery: 20 })
      expect(worstSizeStep).toBeLessThan(ALLOWED[device.name]!)
    }
  })

  test('events handed over late are covered, up to a point', () => {
    // The horizon starts at the newest sample rather than at the frame, so a machine that hands its events
    // over late has to be led further — and that is a real setting the library reads off the clock, not an
    // assumption. What it may not do is follow it anywhere: past about two frames of age the sample is not
    // evidence about where the hand is now, it is history, and extrapolating a whole extra frame from it
    // is how a stall turns into a lurch.
    const leads = [2, 15, 30, 60].map(deliveryLagMs => ({
      deliveryLagMs,
      run: replay({ path: steady(0.8, 30), device: WIRED, durationMs: 2500, deliveryLagMs }),
    }))
    // It follows the lag while the lag is plausible...
    expect(leads[1]!.run.meanLead).toBeGreaterThan(leads[0]!.run.meanLead * 1.4)
    expect(leads[2]!.run.meanLead).toBeGreaterThan(leads[1]!.run.meanLead * 1.3)
    // ...and then stops, because a sample two frames old is not news.
    expect(leads[3]!.run.meanLead).toBeLessThan(42)
    for (const { run } of leads) {
      expect(run.worstSizeStep).toBeLessThan(0.3)
      expect(run.gain).toBeLessThan(0.45)
    }

    // And a stop is still a stop when everything about it arrives late.
    for (const device of [WIRED, TRACKPAD]) {
      const stop = replay({ path: flick(2.6, 20, 800, 150), device, durationMs: 1350, deliveryLagMs: 30 })
      expect(stop.worstOvershoot).toBeLessThan(40)
      expect(stop.phantom).toBeLessThan(30)
    }
  })

  test('the picture moves as unevenly as the device reports, and no worse', () => {
    // **The biggest jump in this library is not in this library.** A hand at a dead constant speed should
    // make a picture that moves the same distance every frame; on every device that coalesces, it does not,
    // because the device's report interval and the display's refresh interval do not divide into each other.
    // A trackpad reporting every 11ms into a 16.7ms frame delivers two samples on some frames and one on
    // others, so the picture steps 55px and then 28px with the hand moving perfectly steadily.
    //
    // The lead neither causes it nor removes it: the two columns below are the picture with the guess
    // applied and the reported position on its own, and they are the same figure. What the lead *could* do
    // is remove it — the newest sample says exactly how stale the reported position is, so the motion
    // missing from it is arithmetic rather than a guess. It is not done, for a reason worth writing down:
    // that correction has to alternate every frame, and half this library's callers spend the lead through
    // `createLeadRatchet`, which keeps growth and never gives it back. Feeding an alternating term through a
    // ratchet turns it into permanent drift — measured at thirteen times the accumulation on a trackpad.
    // Fixing it properly means smoothing the delivery on the way in, where a ratchet never sees it, and that
    // is a change to the buffer rather than to the guess.
    const BEAT: Record<string, { withLead: number; bare: number }> = {
      wired: { withLead: 1.2, bare: 0.9 },
      '8KHz mouse': { withLead: 1.2, bare: 0.9 },
      '500Hz mouse': { withLead: 2.3, bare: 2 },
      '125Hz mouse': { withLead: 6.8, bare: 6.4 },
      trackpad: { withLead: 5.8, bare: 5.3 },
      bluetooth: { withLead: 13.3, bare: 13.4 },
      'slow radio': { withLead: 14.6, bare: 14.5 },
      'low-DPI mouse': { withLead: 7.3, bare: 6.7 },
      'half-pixel mouse': { withLead: 3.1, bare: 2.8 },
      sparse: { withLead: 13.5, bare: 13.4 },
    }
    for (const device of ALL_DEVICES) {
      const limits = BEAT[device.name]!
      const path = steady(0.8, 30)
      const guessed = replay({ path, device, durationMs: 2500 })
      // What the same picture does with no lead applied at all: the beat by itself.
      let bare = 0
      let previousReported: { x: number; y: number } | null = null
      let previousTruth: { x: number; y: number } | null = null
      replay({
        path,
        device,
        durationMs: 2500,
        onFrame: frame => {
          const truth = path(frame.frameAt + FRAME)
          if (previousReported && previousTruth && frame.frameAt > 600) {
            bare = Math.max(
              bare,
              Math.abs(
                Math.hypot(frame.reported.x - previousReported.x, frame.reported.y - previousReported.y) -
                  Math.hypot(truth.x - previousTruth.x, truth.y - previousTruth.y),
              ),
            )
          }
          previousReported = { x: frame.reported.x, y: frame.reported.y }
          previousTruth = truth
        },
      })
      expect(bare).toBeLessThan(limits.bare + 0.05)
      expect(guessed.worstJump).toBeLessThan(limits.withLead)
      // The guess may not make it worse than the device already is by more than a fraction of a pixel.
      expect(guessed.worstJump).toBeLessThan(bare + 1)
    }
  })

  test('a device nobody would call fast still gets a guess worth having', () => {
    // One report every 25ms with 4ms of wander: most frames see nothing at all and the window holds two or
    // three samples. It cannot be as good as a wired mouse and it must not be useless.
    for (const path of [steady(0.8, 30), flick(2.6, 20, 800, 150)]) {
      const metrics = replay({ path, device: SPARSE, durationMs: 2500 })
      expect(metrics.gain).toBeLessThan(0.45)
    }
  })
})

describe('a device whose counts are wider than a pixel', () => {
  // Every noise floor in the fit is written in units of one count, and what a count is worth in pixels is
  // not something a browser reports: it is the mouse's resolution, the OS's scaling and the page's device
  // pixel ratio multiplied together. Assumed to be one pixel, as it was, a device reporting four made every
  // floor four times too low and its noise was believed as motion — the guess swung 28 degrees of heading a
  // frame on a dead straight path, jumped thirty times as far in size as the same hand on a 125Hz mouse
  // reporting just as often, ratcheted nine times as much, and led a crawl it should have refused.
  //
  // The count is measured now, off the only thing that knows: every delta a device reports is a whole number
  // of counts, so the grid they sit on is their greatest common divisor. These are the same four figures
  // afterwards, and the control below is what they are supposed to look like.
  test('is measured off the deltas, and the floors follow it', () => {
    const fast = replay({ path: steady(0.8, 30), device: COARSE, durationMs: 2500 })
    const fine = replay({ path: steady(0.8, 30), device: USB_125, durationMs: 2500 })
    expect(fast.worstSizeStep).toBeLessThan(0.75)
    expect(fast.worstTurnStep).toBeLessThan(1.5)
    expect(fast.kept).toBeLessThan(65)
    // Not as good as one-pixel counts — four times the quantisation is four times the quantisation — but
    // within a few times of it rather than a couple of orders.
    expect(fast.worstSizeStep).toBeLessThan(fine.worstSizeStep * 5)
    expect(fast.worstTurnStep).toBeLessThan(fine.worstTurnStep * 5)
    expect(fast.kept).toBeLessThan(fine.kept * 3)

    const slow = replay({ path: steady(0.15, 30), device: COARSE, durationMs: 2500 })
    expect(slow.worstTurnStep).toBeLessThan(1)
    expect(slow.worstSizeStep).toBeLessThan(0.65)
  })

  test('is not paid for in lead on a hand moving normally', () => {
    // The floors going up is the point; the gate going up with them would not be. A drag at 0.8px/ms puts
    // twenty counts across the window on this device, which is far too few to fit a curve to and plenty to
    // say how fast the hand is going — so the travel is read with the extra uncertainty taken off it rather
    // than the threshold being multiplied, and an ordinary hand keeps its lead.
    const drag = replay({ path: steady(0.8, 30), device: COARSE, durationMs: 2500 })
    expect(drag.meanLead).toBeGreaterThan(14)
    expect(drag.gain).toBeLessThan(0.24)
    const aiming = replay({ path: steady(0.35, 25), device: COARSE, durationMs: 2500 })
    expect(aiming.meanLead).toBeGreaterThan(5)
    expect(aiming.gain).toBeLessThan(0.45)
  })

  test('costs the curvature, which four-pixel counts genuinely cannot carry', () => {
    // **The trade, pinned so it can be argued with.** A second derivative over a window holding a handful of
    // four-pixel steps sits about 1.3 times its own noise, and a floor that knows what a count is worth now
    // says so — where before it read five times its noise and was believed outright. So the arc is mostly
    // given up on this device and the guess falls back to the straight line, which on a circle points half a
    // window's worth of turning behind the tangent. Guessing is still better than not guessing, and not by
    // much.
    //
    // It is the honest reading of what the samples support, and it is not the end of the matter: the heading
    // the arc is swept from is the window's average rather than its newest, and advancing it by the turn
    // already measured would give most of this back without believing any more of the curvature. That is a
    // change to how every device extrapolates, so it is a separate one, and these are the numbers it would
    // have to beat.
    for (const [name, gain] of [
      ['circle', 0.94],
      ['circle, hand-drawn', 0.94],
      ['circle, tight and fast', 1],
      ['spiral', 0.81],
      ['figure eight', 0.84],
      ['serpentine', 0.6],
      ['wide slow arc', 0.31],
    ] as const) {
      const scenario = SCENARIOS.find(candidate => candidate.name === name)!
      const metrics = replay({
        path: scenario.path,
        device: COARSE,
        durationMs: scenario.durationMs,
        scoreAfterMs: scenario.scoreAfterMs,
      })
      expect(metrics.gain).toBeLessThanOrEqual(gain)
      // Whatever it costs in lateness, it may not be bought back as shake.
      expect(metrics.worstSizeStep).toBeLessThan(3)
    }
  })

  test('counts finer than a pixel do not lower the floors under them', () => {
    // The other side of the same assumption, and deliberately not symmetric. A device reporting half-pixel
    // steps is quieter than the floors expect, and following it down would mean believing more of what a
    // second derivative reads — on the strength of an estimate made from deltas. Holding at a pixel costs
    // that device a little sensitivity and can break nothing, so this asks that it behaves like the
    // one-pixel device of its own rate rather than better or worse than it.
    const fine = replay({ path: steady(0.8, 30), device: FINE, durationMs: 2500 })
    const pixels = replay({ path: steady(0.8, 30), device: USB_500, durationMs: 2500 })
    expect(fine.worstSizeStep).toBeLessThan(pixels.worstSizeStep * 2)
    expect(fine.gain).toBeLessThan(pixels.gain * 1.5)
    // And a crawl is still refused outright, which is the figure a lowered floor would spend first.
    const crawl = replay({ path: steady(0.06, 30), device: FINE, durationMs: 4000 })
    expect(crawl.worstLead).toBe(0)
  })

  test('one window of deltas that share a factor is not enough to move the floors', () => {
    // A quarter second is long enough for a hand to be regular by accident — a steady stretch reporting
    // threes and nothing else. Believed on its own that puts the floors up threefold and takes two pixels
    // off every reading of the travel, which throttles a slow hand by a third for as long as it lasts. Two
    // windows have to agree, and the second one here does not.
    const predictor = createPointerPredictor()
    let now = 1000
    const step = (deltaPx: number) => {
      predictor.push(now - 13, deltaPx, 0)
      const lead = predictor.update({ nowMs: now, deltaMs: FRAME, ...SHIPPED })
      now += FRAME
      return lead.x
    }
    // 0.18px/ms, a slow deliberate drag, reported in threes for the first window and honestly after it.
    for (let frame = 0; frame < 16; frame++) step(3)
    let worst = Infinity
    // The window straight after the regular one, which is the only one a single-window answer would reach.
    for (let frame = 0; frame < 15; frame++) worst = Math.min(worst, step(frame % 3 === 0 ? 4 : 3))
    expect(worst).toBeGreaterThan(2.8)
  })

  test('is found on whichever axis the hand is using', () => {
    // A hand dragging straight down reports nothing on X at all, so a count looked for on X alone would
    // never be found and the whole drag would be spent assuming pixels. Both axes read the same here, which
    // is the point: an axis-aligned drag is a hand steadying itself, not a special case.
    const downwards = replay({ path: steady(0.8, 90), device: COARSE, durationMs: 2500 })
    const sideways = replay({ path: steady(0.8, 0), device: COARSE, durationMs: 2500 })
    expect(downwards.worstSizeStep).toBeLessThan(0.4)
    expect(sideways.worstSizeStep).toBeLessThan(0.4)
    expect(downwards.worstSizeStep).toBeCloseTo(sideways.worstSizeStep, 6)
  })

  test('a device that keeps stopping is not forgotten between movements', () => {
    // What a count is worth is learned from windows that carried motion, and a hand that moves in bursts
    // leaves most windows empty. Letting an empty one answer would drop the device back to being assumed to
    // report in pixels every time it paused, and it would spend the first half second of every burst there.
    const path = piecewise([hold(200), ...Array.from({ length: 6 }, () => [glide(0.5, 15, 260), hold(300)]).flat()])
    const metrics = replay({ path, device: COARSE, durationMs: 3600, scoreAfterMs: 300 })
    expect(metrics.worstTurnStep).toBeLessThan(12)
    expect(metrics.kept).toBeLessThan(72)
  })

  test('a hand whose deltas happen to share a factor is not mistaken for one', () => {
    // The risk the estimator runs: a hand at a steady speed on an ordinary mouse can report the same delta
    // over and over, and a run of fours has a common divisor of four whatever the device underneath. Two
    // windows have to agree before the floors move, and a real hand does not hold a factor that long — but
    // when it does, the cost has to be small, so this is the pathological case with the wobble turned off.
    const marching = createPointerPredictor()
    let now = 1000
    let lead = 0
    for (let frame = 0; frame < 120; frame++) {
      // Exactly four pixels every millisecond, on a device whose counts are one.
      for (let s = 1; s <= 16; s++) marching.push(now - 13 - FRAME + (s * FRAME) / 16, 4, 0)
      lead = marching.update({ nowMs: now, deltaMs: FRAME, ...SHIPPED }).x
      now += FRAME
    }
    // 4px/ms over about 30ms of horizon is 120px, which the cap holds at 100 either way. What a mistaken
    // count would cost here is the gate taking three pixels off the travel, which is under a percent of it.
    expect(lead).toBeGreaterThan(99)
  })

  test('what a count is worth survives a reset', () => {
    // It is a property of the device, not of the session: dropping it would put the floors back to assuming
    // pixels for the first half second after every unlock, which is exactly when the hand is moving again.
    const predictor = createPointerPredictor()
    let now = 1000
    // Long enough to learn, on a hand slow enough that assuming pixels would lead it.
    for (let frame = 0; frame < 90; frame++) {
      if (frame % 4 === 0) predictor.push(now - 13, 4, 0)
      predictor.update({ nowMs: now, deltaMs: FRAME, ...SHIPPED })
      now += FRAME
    }
    predictor.reset()

    let worst = 0
    for (let frame = 0; frame < 60; frame++) {
      if (frame % 4 === 0) predictor.push(now - 13, 4, 0)
      const lead = predictor.update({ nowMs: now, deltaMs: FRAME, ...SHIPPED })
      worst = Math.max(worst, Math.hypot(lead.x, lead.y))
      now += FRAME
    }
    // One count every four frames is 0.06px/ms, which is a crawl however wide the count is.
    expect(worst).toBeLessThan(2)
  })
})

describe('every refresh rate', () => {
  const RATES = [
    { name: '30Hz', frameMs: HZ_30 },
    { name: '60Hz', frameMs: HZ_60 },
    { name: '120Hz', frameMs: HZ_120 },
    { name: '144Hz', frameMs: HZ_144 },
  ] as const

  test('the lead is a count of refreshes, so a faster display leads for less time', () => {
    // Not a duration: the delay being covered is a count of refreshes, so the same setting has to mean half
    // as long on a screen running twice as fast. What is left at the short end is the age of the newest
    // sample, which is a property of the machine rather than of the display and does not shrink with it.
    const leads = RATES.map(
      rate => replay({ path: steady(0.8, 30), device: WIRED, durationMs: 2500, frameMs: rate.frameMs }).meanLead,
    )
    for (let i = 1; i < leads.length; i++) expect(leads[i]!).toBeLessThan(leads[i - 1]!)
    // A refresh at 30Hz is worth about 13px of this hand, and at 144Hz about 5.5.
    expect(leads[0]!).toBeGreaterThan(24)
    expect(leads[3]!).toBeLessThan(10)
  })

  for (const rate of RATES) {
    test(`${rate.name}: steady motion is steady and stopping is not overshot`, () => {
      // Both figures are held at every rate rather than at 60Hz alone, because everything the ramp and the
      // horizon do is written in milliseconds and a shorter frame is a different number of them.
      const LIMITS: Record<string, { size: number; gain: number; over: number; still: number }> = {
        '30Hz': { size: 1, gain: 0.19, over: 33, still: 11 },
        '60Hz': { size: 0.75, gain: 0.28, over: 38, still: 9 },
        '120Hz': { size: 0.5, gain: 0.43, over: 30, still: 9 },
        '144Hz': { size: 0.62, gain: 0.45, over: 29, still: 9 },
      }
      const limits = LIMITS[rate.name]!
      for (const device of [WIRED, TRACKPAD, BLUETOOTH]) {
        const drag = replay({ path: steady(0.8, 30), device, durationMs: 2500, frameMs: rate.frameMs })
        expect(drag.worstSizeStep).toBeLessThan(limits.size)
        expect(drag.gain).toBeLessThan(limits.gain)

        const stop = replay({ path: flick(2.6, 20, 800, 150), device, durationMs: 1350, frameMs: rate.frameMs })
        expect(stop.worstOvershoot).toBeLessThan(limits.over)
        expect(stop.phantom).toBeLessThan(limits.still)
      }
    })
  }
})

describe('the caller settings', () => {
  test('leadFrames scales the guess, and zero means almost none of it', () => {
    const leads = [0, 1, 2, 3].map(
      leadFrames => replay({ path: steady(0.8, 30), device: WIRED, durationMs: 2500, leadFrames }).meanLead,
    )
    // Zero still covers the time the samples spent getting here, which is a couple of milliseconds on this
    // rig — a few pixels, not a frame's worth.
    expect(leads[0]!).toBeLessThan(4)
    // And each further refresh is worth about another frame of this hand's travel, near enough.
    for (let i = 1; i < leads.length; i++) {
      const added = leads[i]! - leads[i - 1]!
      expect(added).toBeGreaterThan(8)
      expect(added).toBeLessThan(16)
    }
  })

  test('a longer ramp buys steadiness and pays for it in overshoot', () => {
    // The ramp is the caller's feel setting, and the trade it makes has a direction: smoothing the guess
    // harder means arriving later at a stop, which is overshoot and picture moving under a still hand. If a
    // change ever makes both ends better at once, something else has moved and this test should be the one
    // to say so.
    const smooth = (decayMs: number) => replay({ path: steady(0.8, 30), device: TRACKPAD, durationMs: 2500, decayMs })
    const stop = (decayMs: number) =>
      replay({ path: flick(2.6, 20, 800, 150), device: TRACKPAD, durationMs: 1350, decayMs })

    expect(smooth(5).worstSizeStep).toBeGreaterThan(smooth(30).worstSizeStep * 2)
    expect(stop(5).worstOvershoot).toBeLessThan(stop(50).worstOvershoot)
    expect(stop(5).phantom).toBeLessThan(stop(50).phantom)
  })

  test('maxLeadPx is exact, and applies to the vector rather than to each axis', () => {
    // A whip on a diagonal: uncapped this asks for hundreds of pixels. Capping per axis would let a diagonal
    // through at √2 times the figure the caller asked for.
    for (const cap of [5, 20, 60]) {
      let worst = 0
      let worstAxis = 0
      replay({
        path: steady(4, 15),
        device: WIRED,
        durationMs: 1500,
        maxLeadPx: cap,
        onFrame: frame => {
          worst = Math.max(worst, Math.hypot(frame.lead.x, frame.lead.y))
          worstAxis = Math.max(worstAxis, Math.abs(frame.lead.x), Math.abs(frame.lead.y))
        },
      })
      expect(worst).toBeLessThanOrEqual(cap + 1e-9)
      expect(worst).toBeGreaterThan(cap * 0.99)
      expect(worstAxis).toBeLessThanOrEqual(cap + 1e-9)
    }
  })

  test('a ceiling nobody reaches changes nothing', () => {
    // The cap is a feel setting, not a safety rail. Raising it past what the samples ask for has to leave
    // the guess exactly as it was, or it is doing something other than capping.
    // 1.5px/ms asks for about 29px, so none of these ceilings is ever in the way and all three runs have to
    // be the same run. Bit for bit: a cap that changes an answer it was never reached by is a cap being
    // applied to something other than the answer.
    const runs = [60, 100, 1e6].map(maxLeadPx =>
      replay({ path: steady(1.5, 15), device: WIRED, durationMs: 1500, maxLeadPx }),
    )
    for (const run of runs) {
      expect(run.worstLead).toBe(runs[0]!.worstLead)
      expect(run.error).toBe(runs[0]!.error)
    }
    expect(runs[0]!.worstLead).toBeLessThan(60)
  })
})
