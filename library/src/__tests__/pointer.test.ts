import { beforeEach, describe, expect, test } from 'bun:test'

import { createPointerBuffer, type PointerMoveLike } from '../pointer.js'

const move = (
  timeStamp: number,
  movementX: number,
  movementY: number,
  coalesced?: PointerMoveLike[],
): PointerMoveLike => ({
  timeStamp,
  movementX,
  movementY,
  getCoalescedEvents: coalesced ? () => coalesced : undefined,
})

describe('pointer buffer', () => {
  let buffer = createPointerBuffer()
  beforeEach(() => {
    buffer = createPointerBuffer()
  })

  test('a frame gets everything since the last one, and a frame after it gets nothing', () => {
    buffer.push(100, 3, 4)
    buffer.push(101, 2, 1)

    const first = buffer.read(120)
    expect(first.x).toBe(5)
    expect(first.y).toBe(5)
    expect(first.sampleCount).toBe(2)

    // The whole point: draining is what stops a frame between two events applying the last one twice.
    const second = buffer.read(140)
    expect(second.x).toBe(0)
    expect(second.y).toBe(0)
    expect(second.sampleCount).toBe(0)
  })

  test('the samples keep their own times, because a fit needs when each part happened', () => {
    buffer.push(100, 1, 0)
    buffer.push(104, 2, 0)
    buffer.push(108, 3, 0)

    const frame = buffer.read(120)
    expect([...frame.sampleTimes.slice(0, 3)]).toEqual([100, 104, 108])
    expect([...frame.sampleX.slice(0, 3)]).toEqual([1, 2, 3])
  })

  test('y is reported the way the DOM reports it, positive downwards', () => {
    // Not negated on the way in. Which way up a consumer wants it is the consumer's business, and a
    // library that guesses gets it wrong for the one that wanted the other.
    buffer.push(100, 0, 7)
    expect(buffer.read(110).y).toBe(7)
  })

  test('the age is measured from the newest sample, not from the frame', () => {
    // The browser holds move events until just before the callback, so a sample is already a good fraction
    // of a frame old by the time anything reads it. Extrapolating from now instead under-leads by exactly
    // that much.
    buffer.push(100, 5, 0)
    buffer.push(107, 5, 0)
    expect(buffer.read(120).ageMs).toBe(13)
  })

  test('a frame with no input at all reports no age rather than the time since the epoch', () => {
    expect(buffer.read(5000).ageMs).toBe(0)
  })

  test('an absurd single event is clamped on the way in, not at the frame', () => {
    // A pointer-lock recentre delivers one enormous delta. Clamping the frame would also throw away the
    // legitimate motion that shared it; clamping the event keeps the guard on the glitch.
    const clamped = createPointerBuffer({ maxDeltaPx: 300 })
    clamped.push(100, 5000, -5000)
    clamped.push(101, 10, 10)

    const frame = clamped.read(110)
    expect(frame.x).toBe(310)
    expect(frame.y).toBe(-290)
    expect(frame.sampleX[0]).toBe(300)
    expect(frame.sampleY[0]).toBe(-300)
  })

  test('without a clamp nothing is touched', () => {
    buffer.push(100, 5000, 0)
    expect(buffer.read(110).x).toBe(5000)
  })

  test('clear throws away what has accumulated instead of banking it for later', () => {
    buffer.push(100, 50, 50)
    buffer.clear()
    const frame = buffer.read(110)
    expect(frame.x).toBe(0)
    expect(frame.sampleCount).toBe(0)
  })

  describe('coalesced events', () => {
    test('every sample inside one event counts, not just the last', () => {
      // A browser hands over one move event per frame however fast the mouse reports, so on a 1000Hz mouse
      // the samples inside that event are the motion.
      const samples = [move(100, 1, 0), move(101, 2, 0), move(102, 3, 0)]
      buffer.handle(move(102, 6, 0, samples))

      const frame = buffer.read(110)
      expect(frame.x).toBe(6)
      expect(frame.sampleCount).toBe(3)
      expect([...frame.sampleTimes.slice(0, 3)]).toEqual([100, 101, 102])
    })

    test('samples that cancel are still samples, not a UA that fills in nothing', () => {
      // A hand going out and back inside one frame reports samples that sum to zero. Reading that as "this
      // UA leaves movement empty" would throw them away and keep the parent's nothing, losing exactly the
      // motion that is hardest to guess at.
      const samples = [move(100, 8, 0), move(101, -8, 0)]
      buffer.handle(move(101, 0, 0, samples))

      const frame = buffer.read(110)
      expect(frame.x).toBe(0)
      expect(frame.sampleCount).toBe(2)
      expect(frame.sampleX[0]).toBe(8)
      expect(frame.sampleX[1]).toBe(-8)
    })

    test('a UA that leaves the samples empty falls back to the parent', () => {
      const samples = [move(100, 0, 0), move(101, 0, 0)]
      buffer.handle(move(101, 9, 3, samples))

      const frame = buffer.read(110)
      expect(frame.x).toBe(9)
      expect(frame.y).toBe(3)
      expect(frame.sampleCount).toBe(1)
    })

    test('an event with no coalesced list at all is taken on its own', () => {
      buffer.handle(move(100, 4, 5))
      expect(buffer.read(110).x).toBe(4)
    })

    test('a missing movement field cannot turn the sum into NaN', () => {
      // NaN reaches the camera rotation, and there is no recovering from it there.
      buffer.handle({ timeStamp: 100 })
      const frame = buffer.read(110)
      expect(frame.x).toBe(0)
      expect(frame.y).toBe(0)
    })
  })

  test('a frame longer than the buffer keeps the newest samples and the whole sum', () => {
    // The sum has to survive intact — dropping samples may cost a fit nothing, because it only looks at
    // the last few tens of ms, but dropping motion is lost input.
    for (let i = 0; i < 200; i++) buffer.push(1000 + i, 1, 0)

    const frame = buffer.read(1200)
    expect(frame.x).toBe(200)
    expect(frame.sampleCount).toBe(128)
    // The oldest are the ones dropped.
    expect(frame.sampleTimes[frame.sampleCount - 1]).toBe(1199)
  })

  test('listen outside a browser is a no-op rather than a crash', () => {
    // Imported on a server by anything that also renders there.
    const stop = createPointerBuffer().listen(undefined)
    expect(typeof stop).toBe('function')
    stop()
  })

  test('listen feeds the buffer and unlistening stops it', () => {
    const listeners = new Map<string, EventListenerOrEventListenerObject>()
    const target: EventTarget = {
      addEventListener: (type, listener) => listeners.set(type, listener!),
      removeEventListener: type => listeners.delete(type),
      dispatchEvent: () => true,
    }

    const stop = buffer.listen(target)
    const fire = (event: PointerMoveLike) => {
      for (const listener of listeners.values()) (listener as EventListener)(event as unknown as Event)
    }

    fire(move(100, 6, 2))
    expect(buffer.read(110).x).toBe(6)

    stop()
    fire(move(120, 6, 2))
    expect(buffer.read(130).x).toBe(0)
  })

  test('only one of pointermove and mousemove is subscribed, since both fire for the same motion', () => {
    const types: string[] = []
    const target: EventTarget = {
      addEventListener: type => void types.push(type),
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }

    buffer.listen(target)()
    expect(types.length).toBe(1)
    expect(['pointermove', 'mousemove']).toContain(types[0]!)
  })
})
