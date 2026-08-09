import { describe, expect, test } from 'bun:test'

import { circle, DEVICES, FRAME, replay, SCENARIOS, WIRED, worstAcross, type Metrics } from './harness.js'

// Every shape a hand makes, scored on every device, against a floor that was measured rather than hoped for.
//
// The point of this file is that the prediction can be changed without anyone having to sit at a desk with a
// mouse: a shape that got shakier, later, or further past the hand fails here by name. Each row is the worst
// reading across the four devices, so a change that only breaks the trackpad still fails — `bun run bench`
// then says which device and which column moved.
//
// **These are floors, not targets.** Every figure was read off the rig and given about a quarter more room,
// so it fails on a real regression rather than on rounding. A change that improves one should tighten it in
// the same commit, or the floor stops being a floor and the next regression walks straight under it. A
// change that trades one column for another — a stop seen sooner is always lead given up somewhere else —
// should move both numbers and say so.
//
// What each column means is written next to it in `harness.ts`. The short version:
//
//   gain   error against the error of not guessing at all. Under 1 is worth having.
//   size   how much the size of the guess may jump in one frame. Jitter, on the eye's terms.
//   over   how far past the hand the guess may ever sit. Every pixel of it has to be handed back.
//   late   how far behind it may sit. This is the lateness the library exists to remove.
//   kick   the worst single frame of screen motion against the way the hand is going.
//   back   all of that added up over the run.
//   still  screen motion over frames where the hand is not moving at all.
//   lead   how far out the guess may ever be.
//   kept   what a locked-pointer caller accumulates, which keeps the growth of the lead and never gives it
//          back. Believing a turn rotates the guess, and rotation is growth on both axes in turn, so this is
//          where every decision about how far to believe a turn is paid for.
//   jump   the worst frame where the picture moved further, or less far, than it should have. A hand at a
//          constant speed makes a picture that moves the same distance every frame, and the eye reads any
//          departure from that as a jump — which is the artefact a user actually reports, and not the same
//          question as how far the guess is from the truth or how much the lead moved.
type Limits = {
  gain: number
  size: number
  over: number
  late: number
  kick: number
  back: number
  still: number
  lead: number
  jump: number
  kept: number
}

const LIMITS: Record<string, Limits> = {
  // Straight lines. Nothing here is hard to predict, so these are almost entirely about steadiness: the hand
  // is doing nothing new, and every pixel the guess moves by is invented.
  'steady fast': {
    gain: 0.37,
    size: 0.56,
    over: 15,
    late: 26,
    kick: 0,
    back: 0,
    still: 0,
    lead: 30,
    jump: 20,
    kept: 44,
  },
  'steady slow': {
    gain: 0.77,
    size: 0.16,
    over: 0,
    late: 8.6,
    kick: 0.07,
    back: 0.52,
    still: 0,
    lead: 2.85,
    jump: 4.45,
    kept: 5.1,
  },
  // Below the speed gate there is no lead at all, so this one is exact rather than generous: a single pixel
  // of guess here is quantisation being mistaken for motion, and a caller keeping the growth keeps it.
  crawl: { gain: 1.1, size: 0, over: 0, late: 5.5, kick: 0, back: 0, still: 0, lead: 0, jump: 1.5, kept: 0 },
  'steady on-axis': {
    gain: 0.37,
    size: 0.55,
    over: 15,
    late: 26,
    kick: 0,
    back: 0,
    still: 0,
    lead: 30,
    jump: 20,
    kept: 44,
  },
  // Far past the cap, so what is being judged is that the ceiling holds and nothing rings against it.
  whip: {
    gain: 0.46,
    size: 0.95,
    over: 35,
    late: 151,
    kick: 0,
    back: 0,
    still: 0,
    lead: 150,
    jump: 91,
    kept: 140,
  },
  // `jump` here used to be the rig running out of path rather than anything the guess did — the hand stopped
  // dead on the last frame and the picture carried 45px past it. With the glide carried on past the run, what
  // is left is a device delivering nothing for a frame while the hand crosses 50px of pad, which is the
  // bursty devices and not the fit: the wired mouse has no frame over 25px in the whole scenario.
  'ramp up': { gain: 0.47, size: 2.9, over: 42, late: 97, kick: 0, back: 0, still: 0, lead: 146, jump: 62, kept: 131 },

  // Stops. The one moment the guess is asked to give everything back, and the moment it is furthest from
  // being able to see it coming — `still` is what that costs on screen.
  'flick, snapped stop': {
    gain: 0.47,
    size: 21,
    over: 59,
    late: 71,
    kick: 18,
    back: 31,
    still: 45,
    lead: 91,
    jump: 70,
    kept: 128,
  },
  'flick, eased stop': {
    gain: 0.42,
    size: 18,
    over: 45,
    late: 70,
    kick: 9.4,
    back: 31,
    still: 16,
    lead: 91,
    jump: 55,
    kept: 128,
  },
  'abrupt stop': {
    gain: 0.6,
    size: 24,
    over: 27,
    late: 54,
    kick: 0,
    back: 0,
    still: 85,
    lead: 73,
    jump: 81,
    kept: 81,
  },
  'abrupt start': {
    gain: 0.58,
    size: 5.5,
    over: 26,
    late: 150,
    kick: 0,
    back: 0,
    still: 0,
    lead: 73,
    // The same: what remains is a burst device silent for a frame, not the guess moving unevenly.
    jump: 44,
    kept: 80,
  },
  'stop and go': {
    gain: 0.81,
    size: 20,
    over: 24,
    late: 92,
    kick: 16,
    back: 35,
    still: 174,
    lead: 42,
    jump: 61,
    kept: 251,
  },
  'point to point': {
    gain: 0.74,
    size: 5.9,
    over: 16,
    late: 60,
    kick: 3.25,
    back: 9.85,
    still: 30,
    lead: 38,
    jump: 31,
    kept: 46,
  },

  // Turns. A per-axis fit reads the extremum of every one of these as a hand that is stopping, which is
  // exactly backwards, so these are the cases the 2D fit exists for.
  'sharp corner': {
    gain: 0.57,
    size: 3.15,
    over: 18,
    late: 59,
    kick: 1.65,
    back: 2.45,
    still: 0,
    lead: 44,
    jump: 34,
    kept: 68,
  },
  'corner, 45 degrees': {
    gain: 0.48,
    size: 1.9,
    over: 35,
    late: 90,
    kick: 0,
    back: 0,
    still: 0,
    lead: 88,
    jump: 58,
    kept: 124,
  },
  'corner, 90 degrees': {
    gain: 0.62,
    size: 8.25,
    over: 33,
    late: 152,
    kick: 0,
    back: 0,
    still: 0,
    lead: 86,
    jump: 64,
    kept: 129,
  },
  'corner, 135 degrees': {
    gain: 0.73,
    size: 21,
    over: 30,
    late: 200,
    kick: 49,
    back: 49,
    still: 0,
    lead: 84,
    jump: 65,
    kept: 148,
  },
  'corner, slow': {
    gain: 0.61,
    size: 1.3,
    over: 6.3,
    late: 28,
    kick: 0.22,
    back: 0.33,
    still: 0,
    lead: 20,
    jump: 15,
    kept: 30,
  },
  'zigzag, sharp and fast': {
    gain: 0.96,
    size: 8.2,
    over: 52,
    late: 141,
    kick: 36,
    back: 50,
    still: 0,
    lead: 55,
    jump: 60,
    kept: 152,
  },
  'rounded corner': {
    gain: 0.44,
    size: 1.05,
    over: 19,
    late: 46,
    kick: 0,
    back: 0,
    still: 0,
    lead: 45,
    jump: 31,
    kept: 71,
  },
  circle: { gain: 0.36, size: 4.1, over: 24, late: 52, kick: 0.02, back: 0.02, still: 0, lead: 68, jump: 51, kept: 91 },
  'circle, tight and fast': {
    gain: 0.4,
    size: 2.7,
    over: 14,
    late: 35,
    kick: 0.66,
    back: 0.66,
    still: 0,
    lead: 54,
    jump: 44,
    kept: 64,
  },
  // A stir: small and quick enough that a whole horizon of it sweeps past a right angle, which is where the
  // arc has to stop being believed rather than wrap round.
  //
  // `jump` is the one figure here bought rather than won. A hand going round this fast used to read as a hand
  // turning back — the heading it is judged against lagged eighty degrees behind on a lap this tight — and the
  // reversal bound left the slow devices leading half what the fast ones led: 12px against 27px on the same
  // circle. Carried round with the path they lead it properly, and the score says so at every reading but
  // this one: the error falls a seventh, the size of the guess wobbles half as much, and it moves against the
  // hand essentially never. What a bigger guess costs on a device reporting three times a lap is evenness,
  // and 23px of the 30 is there with no guess at all, because a hand turning 55 degrees between two frames is
  // most of the unevenness by itself.
  stir: { gain: 0.95, size: 9.95, over: 0, late: 40, kick: 0, back: 0, still: 0, lead: 35, jump: 33, kept: 70 },
  // The same circle with a hand on it, so the quantisation error stops being a function of the angle and
  // starts being noise. It scores like the clean one, which is what says the clean one is not being flattered
  // by its own regularity.
  'circle, hand-drawn': {
    gain: 0.37,
    size: 5.2,
    over: 26,
    late: 50,
    kick: 0,
    back: 0,
    still: 0,
    lead: 72,
    jump: 51,
    kept: 74,
  },
  'circle, reversed': {
    gain: 0.36,
    size: 4.1,
    over: 24,
    late: 52,
    kick: 0.02,
    back: 0.02,
    still: 0,
    lead: 68,
    jump: 51,
    kept: 91,
  },
  'figure eight': {
    gain: 0.89,
    size: 5.5,
    over: 2.55,
    late: 68,
    kick: 1.3,
    back: 1.7,
    still: 0,
    lead: 39,
    jump: 35,
    kept: 81,
  },
  spiral: { gain: 0.4, size: 4.65, over: 31, late: 68, kick: 0.02, back: 0.02, still: 0, lead: 93, jump: 56, kept: 69 },
  serpentine: {
    gain: 0.71,
    size: 3,
    over: 6.55,
    late: 49,
    kick: 0.04,
    back: 0.04,
    still: 0,
    lead: 32,
    jump: 25,
    kept: 165,
  },
  // A turn slow enough and wide enough that the angle between the window's two halves barely clears what
  // quantisation alone produces. Believing it too readily and not at all are both visible here.
  'wide slow arc': {
    gain: 0.38,
    size: 0.26,
    over: 4.4,
    late: 16,
    kick: 0,
    back: 0,
    still: 0,
    lead: 15,
    jump: 8.05,
    kept: 22,
  },

  // Reversals. Nothing in a window says a turn is coming when the hand is at its fastest, so the guess is
  // bounded by how long this hand has lately been going between turning round rather than by evidence.
  // Gain over 1 is honest here: there is nothing to win, and the job is not to lose much.
  zigzag: { gain: 1.15, size: 9.1, over: 28, late: 70, kick: 31, back: 84, still: 0, lead: 24, jump: 36, kept: 28 },
  'shake, 8Hz': {
    gain: 1.1,
    size: 8.75,
    over: 45,
    late: 50,
    kick: 30,
    back: 200,
    still: 41,
    lead: 11,
    jump: 40,
    kept: 20,
  },
  'shake, fast and small': {
    gain: 1.15,
    size: 3.3,
    over: 30,
    late: 30,
    kick: 25,
    back: 344,
    still: 55,
    lead: 3.85,
    jump: 25,
    kept: 15,
  },
  'overshoot and correct': {
    gain: 0.66,
    size: 17,
    over: 24,
    late: 94,
    kick: 8.65,
    back: 16,
    still: 19,
    lead: 56,
    jump: 45,
    kept: 56,
  },
  'target acquire': {
    gain: 0.68,
    size: 24,
    over: 28,
    late: 113,
    kick: 15,
    back: 15,
    still: 25,
    lead: 63,
    jump: 53,
    kept: 68,
  },
  // Braking is believed on thin evidence and acted on at once, which is right for a stop and is exactly
  // wrong for a hand that is only pausing between two throws. This is the case that pays for that choice.
  'double flick': {
    gain: 0.67,
    size: 25,
    over: 26,
    late: 167,
    kick: 19,
    back: 40,
    still: 33,
    lead: 74,
    jump: 65,
    kept: 159,
  },

  // A hand is never still. The wobble is the size of the counts underneath it, which is where a second
  // derivative reads it as motion and a caller keeping the growth turns it into rotation.
  'tremor on a drag': {
    gain: 0.4,
    size: 1.65,
    over: 5.25,
    late: 16,
    kick: 0.14,
    back: 0.61,
    still: 0,
    lead: 15,
    jump: 15,
    kept: 25,
  },
  'tremor at rest': {
    gain: 1.1,
    size: 0,
    over: 2.5,
    late: 3.5,
    kick: 2,
    back: 4.5,
    still: 15,
    lead: 0,
    jump: 2,
    kept: 0,
  },
}

describe('movement shapes', () => {
  test('a scenario still moving at the end of its run has path left to move along', () => {
    // `piecewise` holds its last position for ever after, which is what a hand that has stopped does — so a
    // path whose segments run out exactly where the run ends reads as a hand stopping dead on the final
    // frame. Nothing about that stop is the scenario's question, and the frames scoring it are the loudest in
    // the run: `ramp up` is asking about an acceleration and its worst jump on every device was the rig
    // running out of path, 45px of picture against a hand that had not moved. Two scenarios were doing it,
    // and neither was scoring the thing it was written to score.
    for (const scenario of SCENARIOS) {
      const end = scenario.durationMs
      const before = scenario.path(end - 40)
      const at = scenario.path(end)
      const after = scenario.path(end + 2 * FRAME)
      const speedBefore = Math.hypot(at.x - before.x, at.y - before.y) / 40
      const speedAfter = Math.hypot(after.x - at.x, after.y - at.y) / (2 * FRAME)
      // A hand that is genuinely still at the end is fine — it is one still moving into the last frame and
      // frozen past it that means the path, rather than the hand, ran out.
      if (speedBefore > 0.05) {
        expect(`${scenario.name}: ${speedAfter.toFixed(3)}px/ms after the run`).toBe(
          `${scenario.name}: ${Math.max(speedAfter, speedBefore * 0.2).toFixed(3)}px/ms after the run`,
        )
      }
    }
  })

  test('every scenario has a floor and every floor has a scenario', () => {
    // A shape added to the rig with nothing holding it is a shape nobody is watching, and a floor left
    // behind by a renamed scenario is a number that can never fail.
    const names = new Set(SCENARIOS.map(scenario => scenario.name))
    expect(SCENARIOS.filter(scenario => !LIMITS[scenario.name]).map(scenario => scenario.name)).toEqual([])
    expect(Object.keys(LIMITS).filter(name => !names.has(name))).toEqual([])
  })

  for (const scenario of SCENARIOS) {
    test(`${scenario.name}: ${scenario.note}`, () => {
      const limits = LIMITS[scenario.name]!
      const worst = worstAcross(DEVICES, {
        path: scenario.path,
        durationMs: scenario.durationMs,
        scoreAfterMs: scenario.scoreAfterMs,
      })
      expect(worst.frames).toBeGreaterThan(10)
      expect(worst.gain).toBeLessThanOrEqual(limits.gain)
      expect(worst.worstSizeStep).toBeLessThanOrEqual(limits.size)
      expect(worst.worstOvershoot).toBeLessThanOrEqual(limits.over)
      expect(worst.worstLate).toBeLessThanOrEqual(limits.late)
      expect(worst.worstBackwards).toBeLessThanOrEqual(limits.kick)
      expect(worst.backwards).toBeLessThanOrEqual(limits.back)
      expect(worst.phantom).toBeLessThanOrEqual(limits.still)
      expect(worst.worstLead).toBeLessThanOrEqual(limits.lead)
      // Both ways of spending a lead: a caller with a true position to add it to, and a locked pointer that
      // can only ever be pushed further along.
      expect(worst.worstJump).toBeLessThanOrEqual(limits.jump)
      expect(worst.worstRatchetJump).toBeLessThanOrEqual(limits.jump)
      expect(worst.kept).toBeLessThanOrEqual(limits.kept)
    })
  }

  test('nothing produces a lead that is not a number', () => {
    // Cheap, and the one failure that would make every figure above meaningless.
    for (const scenario of SCENARIOS) {
      let frames = 0
      replay({
        path: scenario.path,
        device: DEVICES[0]!,
        durationMs: scenario.durationMs,
        onFrame: frame => {
          frames++
          const { x, y, live } = frame.lead
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(live)) {
            throw new Error(`${scenario.name} produced ${frame.lead.x},${frame.lead.y} at frame ${frame.index}`)
          }
        },
      })
      expect(frames).toBeGreaterThan(10)
    }
  })
})

describe('raising the lead does not throw a small circle apart', () => {
  // A hand stirring a small circle quickly is the one shape where a whole horizon is most of a lap, and it
  // used to come apart as `leadFrames` went up: at three refreshes of lead the guess sat 58px off a 25px
  // circle — two diameters from anywhere the hand ever goes — and moved 60px in a frame getting there. Every
  // extra refresh cost more than the last, which is the shape of a guess being extrapolated past the point
  // anything about it is still true.
  //
  // The horizon is bounded by how far the path turns over it now, so the answer stops growing with the
  // setting instead: what a longer lead cannot buy, it no longer spends. Each row is the worst reading
  // across the four devices, and the figures hold at one refresh of lead and at four alike.
  //
  // `off` is the figure that says it: the guess stays the same distance from the circle at four refreshes of
  // lead as at one, which is the property being defended. `jump` on the tightest of the three is a ceiling on
  // evenness rather than on the guess going astray — a hand turning 55 degrees between two frames moves the
  // picture unevenly on a device reporting three times a lap whether or not anything is guessed, and 23px of
  // the 31 below is what that device does with no lead at all.
  const CIRCLES = [
    { r: 25, periodMs: 110, off: 10, jump: 31 },
    { r: 15, periodMs: 150, off: 3, jump: 15 },
    { r: 25, periodMs: 200, off: 3.5, jump: 19 },
  ]

  for (const { r, periodMs, off, jump } of CIRCLES) {
    test(`a ${r}px circle every ${periodMs}ms stays on the circle at any lead`, () => {
      for (const leadFrames of [1, 2, 3, 4]) {
        const run = worstAcross(DEVICES, { path: circle(r, periodMs), durationMs: 3000, leadFrames })
        expect(Math.abs(run.meanRadius - r)).toBeLessThan(off)
        expect(run.worstJump).toBeLessThan(jump)
      }
    })
  }

  test('and the lead setting barely moves any of it', () => {
    // The figures above would pass on a guess that was equally bad at every setting. This is the part that
    // says the setting stopped mattering: four refreshes of lead may not be meaningfully worse than one.
    for (const { r, periodMs } of CIRCLES) {
      const one = worstAcross(DEVICES, { path: circle(r, periodMs), durationMs: 3000, leadFrames: 1 })
      const four = worstAcross(DEVICES, { path: circle(r, periodMs), durationMs: 3000, leadFrames: 4 })
      expect(Math.abs(four.meanRadius - r)).toBeLessThan(Math.abs(one.meanRadius - r) + 1.5)
      expect(four.worstJump).toBeLessThan(one.worstJump * 1.15 + 1)
    }
  })

  test('a medium circle is drawn on the circle, at every speed a hand draws one at', () => {
    // The one a hand actually makes: 120px across, at everything from a quick loop to a slow deliberate one.
    // The guess used to sit well outside it in the middle of that range — 20px out at 600ms a lap on a
    // trackpad, and the marker visibly orbiting outside the path the hand drew.
    //
    // The cause was two gates multiplying. The turn is read from two chords, which is a good measurement
    // even on a thin window, and it was then multiplied by how far the *parabola* was believed — a worse
    // measurement of the same thing, and one that sits near half on a window holding four samples. Two
    // half-open gates left the arc bending at a quarter of the rate the hand was turning, and a lead that
    // lags the heading on a circle points outwards, which is exactly where the marker was.
    //
    // So the turn is judged on its own evidence now, and that evidence is the average of several readings
    // rather than one: a hand going round turns the same way on every frame while quantisation flips, so
    // averaging keeps the turn whole and takes the noise down with the root of how many independent windows
    // went into it.
    const DRIFT: Record<number, number> = { 300: 3, 400: 2, 600: 5, 900: 13, 1400: 9 }
    for (const periodMs of [300, 400, 600, 900, 1400]) {
      const run = worstAcross(DEVICES, { path: circle(120, periodMs), durationMs: 4000 })
      expect(Math.abs(run.meanRadius - 120)).toBeLessThan(DRIFT[periodMs]!)
    }
  })

  test('a circle a hand actually draws is untouched by the bound', () => {
    // The bound is on the turn, not on turning. A wide circle turns a fraction of a right angle over one
    // horizon, so it never reaches the bound and keeps every pixel of lead the setting asks for — the lead
    // has to go on growing with `leadFrames`, or this has quietly become a cap on how far anything is led.
    for (const [r, periodMs] of [
      [60, 400],
      [200, 900],
    ] as const) {
      const leads = [1, 2, 4].map(
        leadFrames => replay({ path: circle(r, periodMs), device: WIRED, durationMs: 3000, leadFrames }).meanLead,
      )
      expect(leads[1]!).toBeGreaterThan(leads[0]! * 1.4)
      expect(leads[2]!).toBeGreaterThan(leads[1]! * 1.25)
      // And it stays on the circle while doing it.
      for (const leadFrames of [1, 2, 4]) {
        const run = replay({ path: circle(r, periodMs), device: WIRED, durationMs: 3000, leadFrames })
        expect(Math.abs(run.meanRadius - r)).toBeLessThan(8)
      }
    }
  })

  test('a wide circle on a device that reports slowly still drifts outside it', () => {
    // **Known, unfixed, and a different mechanism.** The bound above is on how far the path turns over the
    // horizon, and a wide circle never turns far enough to reach it. What puts the guess outside one of
    // those is the turn being believed less than it is: on a window holding four or five samples the two
    // chords it is read from are short, the quantisation floor they are judged against is correspondingly
    // large, and an under-believed turn bends the arc less than the path bends, which leaves along the
    // tangent. A wired mouse on the same circle sits within 6px of it at four refreshes of lead.
    //
    // Fixing it means believing a turn on thinner evidence, which is the same knob that decides whether a
    // slow drag shakes — a different change with a different blast radius. These are the numbers it would
    // have to beat.
    const DRIFT: Record<string, number> = { trackpad: 34, bluetooth: 24, 'slow radio': 39 }
    for (const device of DEVICES) {
      const run = replay({ path: circle(60, 400), device, durationMs: 3000, leadFrames: 4 })
      const allowed = DRIFT[device.name] ?? 3
      expect(run.meanRadius - 60).toBeLessThan(allowed)
    }
  })
})

describe('the shapes that must beat not guessing', () => {
  // A gain over 1 is only ever acceptable where there is nothing to win: a hand reversing faster than the
  // horizon, or one moving too slowly to be led at all. Everywhere else the guess has to earn its place, and
  // by a margin — the lateness it removes is the whole product.
  const EARNS_ITS_PLACE = [
    'steady fast',
    'steady on-axis',
    'whip',
    'ramp up',
    'flick, snapped stop',
    'flick, eased stop',
    'circle',
    'circle, tight and fast',
    'circle, hand-drawn',
    'spiral',
    'point to point',
    'sharp corner',
    'rounded corner',
    'overshoot and correct',
    'target acquire',
    'double flick',
    'wide slow arc',
    'tremor on a drag',
  ]

  for (const name of EARNS_ITS_PLACE) {
    test(`${name} is worth guessing on every device`, () => {
      const scenario = SCENARIOS.find(candidate => candidate.name === name)!
      for (const device of DEVICES) {
        const metrics: Metrics = replay({
          path: scenario.path,
          device,
          durationMs: scenario.durationMs,
          scoreAfterMs: scenario.scoreAfterMs,
        })
        // Two thirds of the error, at worst, on the device that reports least often. The wired figures are
        // several times better than this and are held to the table above.
        expect(metrics.error).toBeLessThan(metrics.errorWithout * 0.67)
      }
    })
  }
})
