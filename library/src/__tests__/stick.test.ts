import { beforeEach, describe, expect, test } from 'bun:test'

import { createStickReader } from '../stick.js'

const at = (identifier: number | null, x: number | null, y: number | null) => ({
  identifier,
  current: { x, y },
})

describe('stick reader', () => {
  let look = createStickReader()
  beforeEach(() => {
    look = createStickReader()
  })

  test('the first frame of a touch moves nothing', () => {
    const first = look.read(at(1, 100, 100))
    expect(first.x).toBe(0)
    expect(first.y).toBe(0)
  })

  test('a frame gets the whole distance travelled since the last one', () => {
    look.read(at(1, 100, 100))
    const moved = look.read(at(1, 130, 90))
    expect(moved.x).toBe(30)
    expect(moved.y).toBe(-10)
  })

  test('a frame with no new touch event moves nothing', () => {
    // The bug this replaces: a joystick holds the last event's delta until a timeout clears it, so a frame
    // landing between two events applied that delta a second time and the camera turned further than the
    // thumb asked.
    look.read(at(1, 100, 100))
    look.read(at(1, 130, 100))
    const idle = look.read(at(1, 130, 100))
    expect(idle.x).toBe(0)
    expect(idle.y).toBe(0)
  })

  test('several events inside one frame all count', () => {
    // And the other half of it: the joystick keeps only the newest event's delta, so everything earlier in
    // a frame was dropped. Position carries all of it.
    look.read(at(1, 100, 100))
    const moved = look.read(at(1, 175, 100))
    expect(moved.x).toBe(75)
  })

  test('lifting and touching again elsewhere is not a movement', () => {
    look.read(at(1, 100, 100))
    look.read(at(1, 120, 100))
    // A new stroke across the screen. The gap between where one finger left and the next arrived is not
    // motion, and a joystick lifted and re-touched quickly still has the old position in place.
    const restarted = look.read(at(2, 400, 300))
    expect(restarted.x).toBe(0)
    expect(restarted.y).toBe(0)

    const then = look.read(at(2, 410, 300))
    expect(then.x).toBe(10)
  })

  test('a released joystick reports nothing and does not jump on the next touch', () => {
    look.read(at(1, 100, 100))
    look.read(at(1, 150, 100))
    const released = look.read(at(null, null, null))
    expect(released.x).toBe(0)

    const touched = look.read(at(3, 500, 500))
    expect(touched.x).toBe(0)
    expect(touched.y).toBe(0)
  })

  test('a reset drops the mark, so a camera coming back does not apply the gap', () => {
    look.read(at(1, 100, 100))
    look.reset()
    const after = look.read(at(1, 400, 100))
    expect(after.x).toBe(0)
  })
})
