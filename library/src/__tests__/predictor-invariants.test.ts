import { describe, expect, test } from 'bun:test'

import { createPointerBuffer } from '../pointer.js'
import { createPointerPredictor, DEFAULT_DECAY_MS, DEFAULT_LEAD_FRAMES, DEFAULT_MAX_LEAD_PX } from '../predictor.js'
import { ALL_DEVICES, circle, FRAME, flick, replay, SCENARIOS, steady, WIRED, type Path } from './harness.js'

// The things that have to be true of every answer, whatever the hand did and whatever reported it, and the
// inputs that are not a hand at all.
//
// The measured floors in the other files say how good the guess is. These say what it may never do — point
// somewhere impossible, return something that is not a number, depend on which way round the screen is, or
// blow up on a device having a bad moment. A floor can be argued about; none of these can.

const uncapped = { leadFrames: DEFAULT_LEAD_FRAMES, decayMs: DEFAULT_DECAY_MS, maxLeadPx: Number.MAX_SAFE_INTEGER }
const shipped = { leadFrames: DEFAULT_LEAD_FRAMES, decayMs: DEFAULT_DECAY_MS, maxLeadPx: DEFAULT_MAX_LEAD_PX }

/** The same hand, reflected in the X axis. */
const mirror =
  (path: Path): Path =>
  (t: number) => {
    const at = path(t)
    return { x: at.x, y: -at.y }
  }

const push = (predictor: ReturnType<typeof createPointerPredictor>, samples: [number, number, number][]) => {
  for (const [t, dx, dy] of samples) predictor.push(t, dx, dy)
}

describe('what every answer has to be', () => {
  test('a number, inside the cap, on every shape and every device', () => {
    // The whole matrix, every frame — including the frames while the window is still filling, which the
    // scored figures elsewhere deliberately skip.
    for (const scenario of SCENARIOS) {
      for (const device of ALL_DEVICES) {
        let frames = 0
        replay({
          path: scenario.path,
          device,
          durationMs: scenario.durationMs,
          maxLeadPx: 40,
          onFrame: frame => {
            frames++
            const { x, y, live } = frame.lead
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(live)) {
              throw new Error(`${scenario.name} on ${device.name}: lead ${x},${y} live ${live}`)
            }
            if (Math.hypot(x, y) > 40 + 1e-9) {
              throw new Error(`${scenario.name} on ${device.name}: ${Math.hypot(x, y)}px past a 40px cap`)
            }
            if (live < 0 || live > 1) throw new Error(`${scenario.name} on ${device.name}: live ${live}`)
          },
        })
        expect(frames).toBeGreaterThan(10)
      }
    }
  })

  test('the same run twice is the same run', () => {
    // Everything here is deterministic on purpose. A figure that wanders between runs is a figure nobody can
    // tune against, and the first sign of state leaking between predictors would be exactly that.
    for (const scenario of SCENARIOS.slice(0, 8)) {
      const once = replay({ path: scenario.path, device: WIRED, durationMs: scenario.durationMs })
      const twice = replay({ path: scenario.path, device: WIRED, durationMs: scenario.durationMs })
      expect(twice).toEqual(once)
    }
  })

  test('two predictors do not see each other', () => {
    // The window and the eased lead are per-instance state, and a caller comparing two settings side by side
    // has to be able to trust that. Feeding one a whole flick must leave the other exactly as it was.
    const alone = createPointerPredictor()
    const alongside = createPointerPredictor()
    const noisy = createPointerPredictor()

    let now = 1000
    const results: number[][] = [[], []]
    for (let f = 0; f < 60; f++) {
      for (let s = 0; s < 8; s++) {
        const at = now - 13 - FRAME + (s * FRAME) / 8
        alone.push(at, 4, 1)
        alongside.push(at, 4, 1)
        // A completely different hand, on its own instance.
        noisy.push(at, -19, 7)
      }
      noisy.update({ nowMs: now, deltaMs: FRAME, ...shipped })
      results[0]!.push(alone.update({ nowMs: now, deltaMs: FRAME, ...shipped }).x)
      results[1]!.push(alongside.update({ nowMs: now, deltaMs: FRAME, ...shipped }).x)
      now += FRAME
    }
    expect(results[1]).toEqual(results[0]!)
    expect(Math.max(...results[0]!)).toBeGreaterThan(5)
  })

  test('mirroring the hand mirrors the guess', () => {
    // Nothing in the fit may prefer one side of the screen. A turn read with the wrong sign, or a floor
    // subtracted rather than believed, tends to show up here first — the two runs stop being reflections.
    for (const path of [steady(0.8, 30), circle(120, 400), flick(2.6, 20, 800, 150)]) {
      for (const device of ALL_DEVICES) {
        const upright = replay({ path, device, durationMs: 1600 })
        const flipped = replay({ path: mirror(path), device, durationMs: 1600 })
        expect(flipped.worstLead).toBeCloseTo(upright.worstLead, 9)
        expect(flipped.error).toBeCloseTo(upright.error, 9)
        expect(flipped.worstOvershoot).toBeCloseTo(upright.worstOvershoot, 9)
      }
    }
  })

  test('the same drag at any angle is the same drag', () => {
    // Off an axis the two axes cross their count boundaries at different moments and the path arrives as a
    // zig-zag staircase, so this cannot be exact — but it has to be close, or the guess has a favourite
    // direction and a hand sweeping round finds it.
    const runs = [0, 22.5, 45, 67.5, 90, 137, -113].map(angle =>
      replay({ path: steady(0.8, angle), device: WIRED, durationMs: 2000 }),
    )
    const leads = runs.map(run => run.meanLead)
    expect(Math.max(...leads) - Math.min(...leads)).toBeLessThan(0.6)
    expect(Math.max(...runs.map(run => run.worstSizeStep))).toBeLessThan(0.12)
  })

  test('the returned object is the same object every frame', () => {
    // Documented, and worth holding: a caller that keeps the reference gets the next frame's answer for
    // free, which is a bug that hides for a long time.
    const predictor = createPointerPredictor()
    const first = predictor.update({ nowMs: 1000, deltaMs: FRAME, ...shipped })
    const second = predictor.update({ nowMs: 1016.7, deltaMs: FRAME, ...shipped })
    expect(second).toBe(first)
  })
})

describe('inputs that are not a hand', () => {
  test('nothing at all', () => {
    const predictor = createPointerPredictor()
    let lead = predictor.update({ nowMs: 1000, deltaMs: FRAME, ...shipped })
    expect(lead.x).toBe(0)
    expect(lead.y).toBe(0)
    for (let f = 0; f < 30; f++) {
      lead = predictor.update({ nowMs: 1000 + f * FRAME, deltaMs: FRAME, ...shipped })
    }
    expect(lead.x).toBe(0)
    expect(lead.live).toBe(0)
  })

  test('one sample, which is a span of nothing', () => {
    const predictor = createPointerPredictor()
    predictor.push(1000, 40, 40)
    const lead = predictor.update({ nowMs: 1013, deltaMs: FRAME, ...uncapped })
    expect(lead.x).toBe(0)
    expect(lead.y).toBe(0)
  })

  test('a pointer-lock recentre, which is one absurd delta', () => {
    // Clamping these belongs on the way in — `createPointerBuffer`'s `maxDeltaPx` — but a caller who has not
    // set one must still not be handed a lead of thousands of pixels, and the cap is what stands there.
    const predictor = createPointerPredictor()
    push(predictor, [
      [1000, 2, 0],
      [1004, 2, 0],
      [1008, 4000, 3000],
      [1012, 2, 0],
    ])
    const lead = predictor.update({ nowMs: 1013, deltaMs: FRAME, ...shipped })
    expect(Number.isFinite(lead.x)).toBe(true)
    expect(Math.hypot(lead.x, lead.y)).toBeLessThanOrEqual(DEFAULT_MAX_LEAD_PX + 1e-9)
  })

  test('two frames landing on the same clock reading', () => {
    // A frame loop that reads the clock twice, or a browser handing over two callbacks in one refresh. The
    // ramp is an exponential of the interval, so zero is the one value it cannot be given carelessly.
    const predictor = createPointerPredictor()
    for (let s = 0; s < 20; s++) predictor.push(1000 + s, 3, 1)
    const first = predictor.update({ nowMs: 1020, deltaMs: FRAME, ...shipped })
    const held = { x: first.x, y: first.y }
    const again = predictor.update({ nowMs: 1020, deltaMs: 0, ...shipped })
    expect(Number.isFinite(again.x)).toBe(true)
    expect(again.x).toBeCloseTo(held.x, 9)
    expect(again.y).toBeCloseTo(held.y, 9)
  })

  test('a frame after the tab came back', () => {
    // Seconds of nothing, then a frame claiming all of it. Nothing about the last motion may survive that.
    const predictor = createPointerPredictor()
    for (let s = 0; s < 40; s++) predictor.push(1000 + s, 5, 5)
    expect(predictor.update({ nowMs: 1040, deltaMs: FRAME, ...shipped }).x).toBeGreaterThan(0)
    const back = predictor.update({ nowMs: 9000, deltaMs: 7960, ...shipped })
    expect(Number.isFinite(back.x)).toBe(true)
    expect(back.x).toBe(0)
    expect(back.live).toBe(0)
  })

  test('a session that has been running for eleven days', () => {
    // The fit centres its positions on the newest sample precisely so the normal equations stay conditioned
    // however long the clock has been running. A timestamp of a billion milliseconds squared is 1e18, which
    // is where a fit that did not centre would come apart.
    const predictor = createPointerPredictor()
    let now = 1e9
    let lead = 0
    for (let f = 0; f < 40; f++) {
      for (let s = 1; s <= 16; s++) predictor.push(now - 13 - FRAME + (s * FRAME) / 16, 0.75, 0.25)
      lead = predictor.update({ nowMs: now, deltaMs: FRAME, ...shipped }).x
      now += FRAME
    }
    // The same hand at the start of a session leads by the same amount.
    const fresh = createPointerPredictor()
    let early = 1000
    let freshLead = 0
    for (let f = 0; f < 40; f++) {
      for (let s = 1; s <= 16; s++) fresh.push(early - 13 - FRAME + (s * FRAME) / 16, 0.75, 0.25)
      freshLead = fresh.update({ nowMs: early, deltaMs: FRAME, ...shipped }).x
      early += FRAME
    }
    expect(lead).toBeCloseTo(freshLead, 6)
    expect(lead).toBeGreaterThan(5)
  })

  test('more samples in one frame than the window can hold', () => {
    // A 8KHz mouse and a long frame, or a device waking up and delivering a backlog. The oldest fall off the
    // end, which costs a fit nothing because the window is shorter than the buffer.
    const predictor = createPointerPredictor()
    for (let s = 0; s < 400; s++) predictor.push(1000 + s * 0.5, 0.4, 0)
    const lead = predictor.update({ nowMs: 1200, deltaMs: FRAME, ...shipped })
    expect(Number.isFinite(lead.x)).toBe(true)
    expect(lead.x).toBeGreaterThan(0)
    expect(lead.x).toBeLessThanOrEqual(DEFAULT_MAX_LEAD_PX)
  })

  test('samples that arrive out of order', () => {
    const predictor = createPointerPredictor()
    for (let i = 0; i < 40; i++) predictor.push(1000 - i * 0.5, 5, 0)
    const lead = predictor.update({ nowMs: 1013, deltaMs: FRAME, ...uncapped })
    expect(Number.isFinite(lead.x)).toBe(true)
    expect(Math.abs(lead.x)).toBeLessThan(100)
  })

  test('a hand that reports movement of nothing', () => {
    // Some devices report an event per poll whether or not the hand moved. All the timestamps in the world
    // do not make that motion.
    const predictor = createPointerPredictor()
    for (let s = 0; s < 60; s++) predictor.push(1000 + s, 0, 0)
    const lead = predictor.update({ nowMs: 1060, deltaMs: FRAME, ...uncapped })
    expect(lead.x).toBe(0)
    expect(lead.y).toBe(0)
  })

  test('a ceiling given the wrong way round', () => {
    // Documented as the magnitude, since a negative ceiling has no other sensible reading and silently
    // handing back nothing at all would be worse.
    const predictor = createPointerPredictor()
    for (let s = 0; s < 40; s++) predictor.push(1000 + s, 6, 0)
    const lead = predictor.update({ nowMs: 1040, deltaMs: FRAME, leadFrames: 1, decayMs: 20, maxLeadPx: -25 })
    expect(lead.x).toBeGreaterThan(0)
    expect(lead.x).toBeLessThanOrEqual(25 + 1e-9)
  })

  test('a reset leaves nothing of the session behind it', () => {
    // Whatever held the lead — a menu, an unlocked pointer, a cutscene — the next frame has to start from
    // nothing rather than fit a curve through motion from before the gap. Not approximately nothing: the
    // same predictor after a reset has to answer exactly as a new one does.
    const used = createPointerPredictor()
    let now = 1000
    for (let f = 0; f < 40; f++) {
      for (let s = 1; s <= 16; s++) used.push(now - 13 - FRAME + (s * FRAME) / 16, 2, -1)
      used.update({ nowMs: now, deltaMs: FRAME, ...shipped })
      now += FRAME
    }
    used.reset()
    expect(used.update({ nowMs: now, deltaMs: FRAME, ...shipped }).x).toBe(0)

    const fresh = createPointerPredictor()
    let freshNow = now + FRAME
    let usedNow = now + FRAME
    for (let f = 0; f < 30; f++) {
      for (let s = 1; s <= 16; s++) {
        used.push(usedNow - 13 - FRAME + (s * FRAME) / 16, 0.9, 0.3)
        fresh.push(freshNow - 13 - FRAME + (s * FRAME) / 16, 0.9, 0.3)
      }
      const a = used.update({ nowMs: usedNow, deltaMs: FRAME, ...shipped })
      const b = fresh.update({ nowMs: freshNow, deltaMs: FRAME, ...shipped })
      expect(a.x).toBeCloseTo(b.x, 9)
      expect(a.y).toBeCloseTo(b.y, 9)
      expect(a.live).toBeCloseTo(b.live, 9)
      usedNow += FRAME
      freshNow += FRAME
    }
  })
})

describe('fed from the buffer rather than by hand', () => {
  test('pushFrame and push agree, sample for sample', () => {
    // The two ends of the library are meant to fit together without the caller unpacking anything, and every
    // figure in these files was measured through `push`. If the frame path lost or reordered a sample, none
    // of them would be measuring what ships.
    const buffered = createPointerPredictor()
    const direct = createPointerPredictor()
    const buffer = createPointerBuffer()

    let now = 1000
    for (let f = 0; f < 40; f++) {
      for (let s = 1; s <= 5; s++) {
        const timeStamp = now - 13 - FRAME + (s * FRAME) / 5
        buffer.handle({ movementX: 3, movementY: -1, timeStamp })
        direct.push(timeStamp, 3, -1)
      }
      buffered.pushFrame(buffer.read(now))
      const a = buffered.update({ nowMs: now, deltaMs: FRAME, ...shipped })
      const b = direct.update({ nowMs: now, deltaMs: FRAME, ...shipped })
      expect(a.x).toBe(b.x)
      expect(a.y).toBe(b.y)
      expect(a.live).toBe(b.live)
      now += FRAME
    }
  })
})
