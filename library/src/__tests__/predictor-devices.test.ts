import { describe, expect, test } from 'bun:test'

import {
  ALL_DEVICES,
  BLUETOOTH,
  COARSE,
  flick,
  HZ_120,
  HZ_144,
  HZ_30,
  HZ_60,
  replay,
  SPARSE,
  steady,
  TRACKPAD,
  USB_125,
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

describe('every device', () => {
  // How much the size of the guess may jump in one frame, on a hand that is doing nothing new. Measured,
  // then given room. The ordering is the interesting part: it tracks how often the device reports, and the
  // one device that breaks the ordering breaks it for a reason worth knowing (see below).
  const STEADY: Record<string, { fast: number; slow: number; gain: number }> = {
    wired: { fast: 0.05, slow: 0.09, gain: 0.06 },
    '8KHz mouse': { fast: 0.04, slow: 0.07, gain: 0.05 },
    '500Hz mouse': { fast: 0.05, slow: 0.09, gain: 0.07 },
    '125Hz mouse': { fast: 0.2, slow: 0.18, gain: 0.14 },
    trackpad: { fast: 0.23, slow: 0.18, gain: 0.17 },
    bluetooth: { fast: 0.73, slow: 0.25, gain: 0.28 },
    'slow radio': { fast: 0.64, slow: 0.29, gain: 0.36 },
    'low-DPI mouse': { fast: 5.9, slow: 3, gain: 0.4 },
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
    // nearly nothing — the low-DPI mouse is the exception and it is a bug rather than a tolerance, so it is
    // held on its own below.
    for (const device of ALL_DEVICES) {
      if (device === COARSE) continue
      const { worstLead, kept } = replay({ path: steady(0.06, 30), device, durationMs: 4000 })
      expect(worstLead).toBe(0)
      expect(kept).toBe(0)
    }
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
      'low-DPI mouse': 12,
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
  // **A known weak spot, written down as numbers so that fixing it shows up as numbers.**
  //
  // Every noise floor in the fit is written in units of one count and one count is assumed to be about one
  // pixel — `QUANTISATION_PX`. That holds for a mouse at default sensitivity, and it does not hold for a
  // low-DPI one, a page at a device pixel ratio other than 1, or an OS scaling the counts on the way
  // through: this device reports four pixels a step, so the bend, the turn and the trend all sit four times
  // higher above floors that have not moved, and noise gets believed as motion.
  //
  // What that costs, against the same hand on a 125Hz mouse that reports just as often: the lead's size
  // jumps thirty times as far in a frame, it swings through 28° of heading on a path with no turn in it at
  // all, and a caller keeping the growth accumulates nine times as much. None of that is a device problem —
  // it is one constant that does not know what a count is worth.
  //
  // These are ceilings on a known-bad case, not a floor anyone is proud of. Scaling the floors by the count
  // size — from the deltas the device actually reports, since nothing else knows — should collapse all four.
  test('is the case the noise floors do not fit', () => {
    const fast = replay({ path: steady(0.8, 30), device: COARSE, durationMs: 2500 })
    expect(fast.worstSizeStep).toBeLessThan(5.9)
    expect(fast.worstTurnStep).toBeLessThan(35)
    expect(fast.kept).toBeLessThan(250)

    const slow = replay({ path: steady(0.15, 30), device: COARSE, durationMs: 2500 })
    expect(slow.worstTurnStep).toBeLessThan(175)

    // And the same constant is what lets a crawl through the speed gate: at 0.06px/ms the hand covers less
    // than a count a frame, so two counts landing close together read as a hand going six times faster than
    // it is. Every other device is led by exactly nothing here.
    const crawl = replay({ path: steady(0.06, 30), device: COARSE, durationMs: 4000 })
    expect(crawl.worstLead).toBeLessThan(8)
    expect(crawl.kept).toBeLessThan(50)
  })

  test('a mouse reporting just as often but in single pixels is steady', () => {
    // The control for the case above: same period, same burst, same wander, one-pixel counts.
    const fine = replay({ path: steady(0.8, 30), device: USB_125, durationMs: 2500 })
    expect(fine.worstSizeStep).toBeLessThan(0.2)
    expect(fine.worstTurnStep).toBeLessThan(1)
    expect(fine.kept).toBeLessThan(25)
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
