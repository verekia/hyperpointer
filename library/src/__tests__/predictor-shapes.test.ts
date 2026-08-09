import { describe, expect, test } from 'bun:test'

import { circle, DEVICES, replay, SCENARIOS, WIRED, worstAcross, type Metrics } from './harness.js'

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
}

const LIMITS: Record<string, Limits> = {
  // Straight lines. Nothing here is hard to predict, so these are almost entirely about steadiness: the hand
  // is doing nothing new, and every pixel the guess moves by is invented.
  'steady fast': { gain: 0.35, size: 0.75, over: 15, late: 25, kick: 0, back: 0, still: 0, lead: 30, jump: 20 },
  'steady slow': { gain: 0.76, size: 0.3, over: 0, late: 8.5, kick: 0.1, back: 1, still: 0, lead: 3, jump: 4.5 },
  // Below the speed gate there is no lead at all, so this one is exact rather than generous: a single pixel
  // of guess here is quantisation being mistaken for motion, and a caller keeping the growth keeps it.
  crawl: { gain: 1.06, size: 0, over: 0, late: 5.5, kick: 0, back: 0, still: 0, lead: 0, jump: 1.5 },
  'steady on-axis': { gain: 0.35, size: 0.8, over: 15, late: 25, kick: 0, back: 0, still: 0, lead: 30, jump: 20 },
  // Far past the cap, so what is being judged is that the ceiling holds and nothing rings against it.
  whip: { gain: 0.44, size: 0.7, over: 35, late: 150, kick: 0.01, back: 0.01, still: 0, lead: 150, jump: 90 },
  'ramp up': { gain: 0.4, size: 4, over: 45, late: 85, kick: 0, back: 0, still: 0, lead: 150, jump: 85 },

  // Stops. The one moment the guess is asked to give everything back, and the moment it is furthest from
  // being able to see it coming — `still` is what that costs on screen.
  'flick, snapped stop': {
    gain: 0.41,
    size: 25,
    over: 60,
    late: 65,
    kick: 20,
    back: 35,
    still: 40,
    lead: 95,
    jump: 70,
  },
  'flick, eased stop': { gain: 0.4, size: 20, over: 45, late: 65, kick: 9.5, back: 30, still: 30, lead: 95, jump: 55 },
  'abrupt stop': { gain: 0.55, size: 25, over: 30, late: 50, kick: 0, back: 0, still: 85, lead: 75, jump: 80 },
  'abrupt start': { gain: 0.47, size: 10, over: 30, late: 150, kick: 0, back: 0, still: 0, lead: 75, jump: 60 },
  'stop and go': { gain: 0.72, size: 20, over: 35, late: 85, kick: 15, back: 35, still: 250, lead: 55, jump: 60 },
  'point to point': { gain: 0.63, size: 6, over: 20, late: 50, kick: 3.5, back: 15, still: 55, lead: 45, jump: 30 },

  // Turns. A per-axis fit reads the extremum of every one of these as a hand that is stopping, which is
  // exactly backwards, so these are the cases the 2D fit exists for.
  'sharp corner': { gain: 0.49, size: 6, over: 20, late: 55, kick: 0, back: 0, still: 0, lead: 45, jump: 35 },
  'corner, 45 degrees': { gain: 0.42, size: 4, over: 35, late: 85, kick: 0, back: 0, still: 0, lead: 90, jump: 60 },
  'corner, 90 degrees': { gain: 0.55, size: 15, over: 35, late: 150, kick: 0, back: 0, still: 0, lead: 90, jump: 65 },
  'corner, 135 degrees': {
    gain: 0.65,
    size: 20,
    over: 35,
    late: 200,
    kick: 40,
    back: 40,
    still: 0,
    lead: 90,
    jump: 75,
  },
  'corner, slow': { gain: 0.5, size: 2.5, over: 7, late: 25, kick: 0, back: 0, still: 0, lead: 20, jump: 15 },
  'zigzag, sharp and fast': {
    gain: 0.89,
    size: 15,
    over: 50,
    late: 150,
    kick: 35,
    back: 50,
    still: 0,
    lead: 65,
    jump: 60,
  },
  'rounded corner': { gain: 0.47, size: 2, over: 20, late: 50, kick: 0, back: 0, still: 0, lead: 45, jump: 30 },
  circle: { gain: 0.34, size: 7.5, over: 25, late: 50, kick: 0, back: 0, still: 0, lead: 70, jump: 50 },
  'circle, tight and fast': {
    gain: 0.39,
    size: 5,
    over: 20,
    late: 35,
    kick: 0.75,
    back: 0.75,
    still: 0,
    lead: 55,
    jump: 45,
  },
  // A stir: small and quick enough that a whole horizon of it sweeps past a right angle, which is where the
  // arc has to stop being believed rather than wrap round.
  stir: { gain: 0.95, size: 15, over: 0, late: 40, kick: 0, back: 0, still: 0, lead: 35, jump: 30 },
  // The same circle with a hand on it, so the quantisation error stops being a function of the angle and
  // starts being noise. It scores like the clean one, which is what says the clean one is not being flattered
  // by its own regularity.
  'circle, hand-drawn': { gain: 0.35, size: 9, over: 25, late: 50, kick: 0, back: 0, still: 0, lead: 75, jump: 50 },
  'circle, reversed': { gain: 0.34, size: 7.5, over: 25, late: 50, kick: 0, back: 0, still: 0, lead: 70, jump: 50 },
  'figure eight': { gain: 0.86, size: 7.5, over: 15, late: 65, kick: 2.5, back: 3.5, still: 0, lead: 50, jump: 35 },
  spiral: { gain: 0.58, size: 8, over: 30, late: 75, kick: 0, back: 0, still: 0, lead: 95, jump: 60 },
  serpentine: { gain: 0.69, size: 3.5, over: 15, late: 45, kick: 0, back: 0, still: 0, lead: 30, jump: 25 },
  // A turn slow enough and wide enough that the angle between the window's two halves barely clears what
  // quantisation alone produces. Believing it too readily and not at all are both visible here.
  'wide slow arc': { gain: 0.36, size: 0.45, over: 4.5, late: 15, kick: 0, back: 0, still: 0, lead: 15, jump: 8 },

  // Reversals. Nothing in a window says a turn is coming when the hand is at its fastest, so the guess is
  // bounded by how long this hand has lately been going between turning round rather than by evidence.
  // Gain over 1 is honest here: there is nothing to win, and the job is not to lose much.
  zigzag: { gain: 1.06, size: 15, over: 20, late: 75, kick: 30, back: 90, still: 0, lead: 30, jump: 35 },
  'shake, 8Hz': { gain: 1.11, size: 9, over: 45, late: 50, kick: 30, back: 200, still: 40, lead: 15, jump: 40 },
  'shake, fast and small': {
    gain: 1.11,
    size: 6,
    over: 30,
    late: 30,
    kick: 25,
    back: 350,
    still: 55,
    lead: 5.5,
    jump: 25,
  },
  'overshoot and correct': {
    gain: 0.55,
    size: 15,
    over: 35,
    late: 85,
    kick: 7,
    back: 15,
    still: 35,
    lead: 65,
    jump: 45,
  },
  'target acquire': { gain: 0.54, size: 20, over: 40, late: 100, kick: 20, back: 20, still: 30, lead: 75, jump: 55 },
  // Braking is believed on thin evidence and acted on at once, which is right for a stop and is exactly
  // wrong for a hand that is only pausing between two throws. This is the case that pays for that choice.
  'double flick': { gain: 0.55, size: 25, over: 40, late: 150, kick: 20, back: 50, still: 45, lead: 85, jump: 65 },

  // A hand is never still. The wobble is the size of the counts underneath it, which is where a second
  // derivative reads it as motion and a caller keeping the growth turns it into rotation.
  'tremor on a drag': { gain: 0.39, size: 2, over: 5.5, late: 15, kick: 0.25, back: 2, still: 0, lead: 15, jump: 15 },
  'tremor at rest': { gain: 1.06, size: 2, over: 2.5, late: 3.5, kick: 2, back: 4.5, still: 15, lead: 1.5, jump: 2 },
}

describe('movement shapes', () => {
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
  const CIRCLES = [
    { r: 25, periodMs: 110, off: 10, jump: 24 },
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
