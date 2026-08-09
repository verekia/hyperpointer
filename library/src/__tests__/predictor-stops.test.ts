import { describe, expect, test } from 'bun:test'

import {
  ALL_DEVICES,
  BLUETOOTH,
  DEVICES,
  flick,
  glide,
  hold,
  piecewise,
  replay,
  SPARSE,
  TRACKPAD,
  WIRED,
  type ReplayOptions,
} from './harness.js'

// Stopping, and the overshoot that comes with it.
//
// This is where a guess is most exposed, and it is asymmetric in a way the error figures alone do not show:
// lead that turns out not to have been needed has to be handed back, and handing it back walks the view
// backwards under the hand, where lead that was never taken is only the lateness the library exists to
// remove. So everything here is scored on which side of the hand the guess was on, and how much of the
// picture moved while the hand itself was not moving at all.
//
// Nothing in a window says a stop is coming until it is already under way, so none of these figures can go
// to zero. What they can do is get worse without anyone noticing, which is what they are here for.

type Frame = Parameters<NonNullable<ReplayOptions['onFrame']>>[0]

const framesOf = (options: Omit<ReplayOptions, 'onFrame'>): Frame[] => {
  const list: Frame[] = []
  replay({ ...options, onFrame: frame => list.push(frame) })
  return list
}

const size = (frame: Frame) => Math.hypot(frame.lead.x, frame.lead.y)

/** A hand crossing the pad and coming off it between one sample and the next. */
const stopsAt = (movingMs: number, quietMs = 700) => piecewise([glide(2, 40, movingMs), hold(quietMs)])

/** Everything about the run after the moment the hand stopped. */
const afterTheStop = (movingMs: number, device: (typeof ALL_DEVICES)[number], quietMs = 700) => {
  const frames = framesOf({ path: stopsAt(movingMs, quietMs), device, durationMs: movingMs + quietMs }).filter(
    frame => frame.frameAt >= movingMs,
  )
  let travel = 0
  let grew = 0
  for (let i = 1; i < frames.length; i++) {
    const before = frames[i - 1]!
    const now = frames[i]!
    travel += Math.hypot(now.shown.x - before.shown.x, now.shown.y - before.shown.y)
    grew = Math.max(grew, size(now) - size(before))
  }
  const zeroAt = frames.findIndex(frame => size(frame) === 0)
  const deadAt = frames.findIndex(frame => frame.lead.live === 0)
  return {
    peak: Math.max(...frames.map(size)),
    /** Frames until the lead is exactly zero, and until the predictor calls the hand stopped. */
    zeroAt: zeroAt === -1 ? frames.length : zeroAt,
    deadAt: deadAt === -1 ? frames.length : deadAt,
    /** How far the picture travelled with the hand already still. */
    travel,
    /** The most the guess ever grew on a frame after the hand had stopped. */
    grew,
  }
}

describe('stopping', () => {
  test('the lead settles at exactly zero, on every device', () => {
    // Not "near zero": a caller that keeps what it is given keeps a creeping remainder for the rest of the
    // session, and a tenth of a pixel a frame is a degree of rotation a minute.
    for (const device of ALL_DEVICES) {
      const { zeroAt } = afterTheStop(900, device)
      expect(zeroAt).toBeLessThanOrEqual(18)
      expect(zeroAt).toBeGreaterThan(2)
    }
  })

  test('the predictor calls the hand stopped within a few frames of it stopping', () => {
    // `live` is the signal a caller watches to drop the lead outright. It has to tolerate the quiet each
    // device keeps while moving — a mouse on a radio leaves a third of frames empty — without letting a
    // real stop go unnoticed for longer than the eye takes to see it.
    for (const device of ALL_DEVICES) {
      expect(afterTheStop(900, device).deadAt).toBeLessThanOrEqual(7)
    }
  })

  test('nothing grows once the hand has stopped', () => {
    // A frame that carries no samples has learned nothing, and a guess that grows on it is inventing motion
    // on the one frame the eye is most likely to get: the next one is already being discounted.
    for (const device of ALL_DEVICES) {
      expect(afterTheStop(900, device).grew).toBeLessThan(1)
    }
  })

  test('how long the hand moved first does not change how the stop ends', () => {
    // The window is a fixed forty milliseconds, so a flick and a long drag end the same way. Anything that
    // makes a long drag unwind more slowly is state that has been accumulating where it should not.
    for (const device of [WIRED, TRACKPAD, BLUETOOTH]) {
      const brief = afterTheStop(200, device)
      const long = afterTheStop(3000, device)
      expect(Math.abs(long.zeroAt - brief.zeroAt)).toBeLessThanOrEqual(3)
      expect(long.travel).toBeLessThan(brief.travel * 1.5 + 5)
    }
  })

  test('the picture moves less with the hand still than the guess it was holding', () => {
    // Everything the guess holds at the moment the hand stops has to be given back, so this can never be
    // nothing. What it must not be is more than that: a lead that unwinds past zero, or rings, or is still
    // being topped up from a stale window, all show up as the picture travelling further than the lead ever
    // was. The sparse device is exempt from the tight figure — it can be two frames late learning the hand
    // moved at all, let alone that it stopped.
    for (const device of ALL_DEVICES) {
      const { travel, peak } = afterTheStop(900, device)
      expect(travel).toBeLessThan(peak * (device === SPARSE ? 1.9 : 1.45))
    }
  })
})

describe('coming off a flick', () => {
  // A cosine fall from a hard cruise: 40ms is a hand snapping to a halt, 400ms is letting go of a long drag.
  // The overshoot allowed is per device and per fall, because the slower a device reports the later it can
  // possibly know — and it is measured along the way the hand is going, so it is overshoot by itself rather
  // than the ordinary lateness rolled in with it.
  const OVERSHOOT: Record<string, Partial<Record<number, number>>> = {
    wired: { 40: 38, 80: 26, 150: 12, 250: 6, 400: 4.5 },
    trackpad: { 40: 50, 80: 44, 150: 24, 250: 18, 400: 18 },
    bluetooth: { 40: 65, 80: 53, 150: 35, 250: 33, 400: 31 },
    'slow radio': { 40: 60, 80: 57, 150: 45, 250: 40, 400: 36 },
  }

  for (const fallMs of [40, 80, 150, 250, 400]) {
    test(`a ${fallMs}ms stop is not led past where the hand ends up`, () => {
      for (const device of DEVICES) {
        const path = flick(2.6, 20, 800, fallMs)
        const durationMs = 800 + fallMs + 400
        const metrics = replay({ path, device, durationMs })
        expect(metrics.worstOvershoot).toBeLessThan(OVERSHOOT[device.name]![fallMs]!)
        // And none of it may be bought by simply not guessing, which would score perfectly on overshoot.
        expect(metrics.error).toBeLessThan(metrics.errorWithout * 0.45)
        // Nor by handing back more than was ever taken.
        expect(metrics.backwards).toBeLessThan(metrics.worstLead)
      }
    })
  }

  test('the lead is already coming down while the hand is still moving', () => {
    // The whole reason for fitting a curve rather than smoothing a velocity. An estimator that cannot see a
    // stop coming is still near its peak when the hand is already still; this asks where the guess is at the
    // moment the hand has given up half its speed, which is halfway through the fall.
    //
    // A 40ms fall is excluded: the hand is gone inside two frames and nothing can be read that fast. The
    // slower the device reports, the later it can know, which is what the second figure is.
    const HALFWAY: Record<string, number> = { wired: 0.62, trackpad: 0.78, bluetooth: 0.88, 'slow radio': 0.82 }
    for (const fallMs of [80, 150, 250]) {
      for (const device of DEVICES) {
        const path = flick(2.6, 20, 800, fallMs)
        const frames = framesOf({ path, device, durationMs: 800 + fallMs + 400 })
        const peak = Math.max(...frames.filter(frame => frame.frameAt < 800).map(size))
        const halfway = frames.find(frame => frame.frameAt >= 800 + fallMs / 2)!
        expect(size(halfway)).toBeLessThan(peak * HALFWAY[device.name]!)
      }
    }
  })

  test('the guess never points backwards through a stop', () => {
    // Past the vertex of a fitted parabola the slope inverts, so the tail of a flick asks to be led
    // backwards. That is a visible kick and no sample supports it: a guess may say the hand is about to
    // slow, it may not say the hand is about to reverse.
    //
    // Every device, with nothing set aside. The low-DPI mouse used to need four pixels of allowance here:
    // its counts are four pixels wide, the turn rate was read against a floor written in units of one, and
    // at the tail of a stop the held lead was spun through a right angle by a turn that was entirely
    // staircase. With the count measured rather than assumed there is nothing left to allow.
    for (const device of ALL_DEVICES) {
      for (const fallMs of [40, 150, 400]) {
        let worst = 0
        framesOf({ path: flick(2.6, 20, 800, fallMs), device, durationMs: 800 + fallMs + 400 }).forEach(frame => {
          const along = frame.lead.x * Math.cos((20 * Math.PI) / 180) + frame.lead.y * Math.sin((20 * Math.PI) / 180)
          worst = Math.min(worst, along)
        })
        expect(worst).toBeGreaterThanOrEqual(-0.05)
      }
    }
  })
})

describe('starting again', () => {
  test('a hard reversal turns the lead round within a few frames', () => {
    // Not a shake — the hand runs one way for most of a second and then the other, so there is a genuine
    // reversal in the window rather than an oscillation to be bounded. The guess has to follow it, and the
    // only thing that can carry it is the measured travel turning round.
    const path = piecewise([glide(1.5, 0, 700), glide(1.5, 180, 700)])
    for (const device of DEVICES) {
      const after = framesOf({ path, device, durationMs: 1400 }).filter(frame => frame.frameAt >= 700)
      const flipped = after.findIndex(frame => frame.lead.x < 0)
      expect(flipped).toBeGreaterThanOrEqual(0)
      expect(flipped).toBeLessThanOrEqual(10)
      // And it has to be worth something once it has turned, not merely the right sign.
      expect(after.slice(0, 12).some(frame => frame.lead.x < -5)).toBe(true)
    }
  })

  test('a start from rest arrives without inventing motion first', () => {
    // The frame the hand starts moving carries a window that is almost entirely the stillness before it, so
    // the guess has to grow into the motion rather than jump. Anything that jumps here is a fit reading a
    // span of a fraction of a millisecond.
    const path = piecewise([hold(500), glide(2, 40, 900)])
    for (const device of ALL_DEVICES) {
      const frames = framesOf({ path, device, durationMs: 1400 })
      let worstGrowth = 0
      for (let i = 1; i < frames.length; i++)
        worstGrowth = Math.max(worstGrowth, size(frames[i]!) - size(frames[i - 1]!))
      // A frame's worth of the motion itself is about 33px, and the guess is about 40px, so it may not
      // arrive in one step. It also may not take for ever: the second figure is the point of the library.
      expect(worstGrowth).toBeLessThan(12)
      const settled = frames.filter(frame => frame.frameAt > 700)
      expect(Math.max(...settled.map(size))).toBeGreaterThan(20)
    }
  })

  test('repeated starts and stops do not accumulate into rotation', () => {
    // Six flicks with a pause after each. A caller applying only the growth keeps every upward wobble and
    // gives none of them back, so anything shaky here is not paid back at the stop — it is kept for the rest
    // of the session. About one lead per cycle is the honest figure; several times that is a ratchet.
    const cycle = [glide(1.6, 15, 200), hold(180)]
    const path = piecewise([hold(200), ...Array.from({ length: 6 }, () => cycle).flat()])
    for (const device of DEVICES) {
      const { kept, worstLead } = replay({ path, device, durationMs: 2700 })
      expect(kept).toBeLessThan(worstLead * 7)
    }
  })

  test('a pause before a flick does not buy the flick a longer stop', () => {
    // How long a device stays quiet while the hand is moving has to be learned. What is far too easy to
    // learn by mistake is the hand sitting still, which looks identical and is many times longer — taken for
    // a property of the device it says this one reports three times a second, and the flick after it sails
    // on with the hand already still.
    for (const device of DEVICES) {
      const sail = (idleMs: number) => {
        const path = piecewise([hold(idleMs), glide(2, 40, 500), hold(600)])
        const frames = framesOf({ path, device, durationMs: idleMs + 1100 }).filter(
          frame => frame.frameAt >= idleMs + 500,
        )
        const zeroAt = frames.findIndex(frame => size(frame) === 0)
        return zeroAt === -1 ? frames.length : zeroAt
      }
      const straightIn = sail(50)
      for (const idleMs of [200, 500, 1500, 4000]) {
        expect(sail(idleMs)).toBeLessThanOrEqual(straightIn + 2)
      }
    }
  })
})

describe('the picture never fights the hand', () => {
  // The one error a camera cannot hide is the view walking backwards while the hand is moving forwards. It
  // costs nothing to be late; it costs the illusion to reverse.
  //
  // A hand that simply stops never produces any of it, and neither does a corner at speed: the lead comes
  // off while the hand is still travelling, so the picture only slows. It is the eased stop that does, and
  // by how much is entirely a question of how late the device is — the wired mouse gives back a seventh of a
  // pixel in the worst frame and the slow radio gives back fourteen. That is the shape of the whole
  // trade-off in one number, and it is the number to watch when the braking is touched.
  const CASES = [
    {
      name: 'a long drag stopping',
      path: stopsAt(900),
      durationMs: 1600,
      kick: { wired: 0.5, trackpad: 0.5, bluetooth: 0.5, 'slow radio': 0.5 },
    },
    {
      name: 'a flick easing out',
      path: flick(2.6, 20, 800, 150),
      durationMs: 1350,
      kick: { wired: 0.4, trackpad: 3.5, bluetooth: 11, 'slow radio': 17 },
    },
    {
      name: 'a corner at speed',
      path: piecewise([glide(1.2, 0, 900), glide(1.2, 90, 900)]),
      durationMs: 1800,
      kick: { wired: 0.5, trackpad: 0.5, bluetooth: 0.5, 'slow radio': 0.5 },
    },
  ] as const

  for (const { name, path, durationMs, kick } of CASES) {
    test(name, () => {
      for (const device of DEVICES) {
        expect(replay({ path, device, durationMs }).worstBackwards).toBeLessThan(kick[device.name as keyof typeof kick])
      }
    })
  }
})
