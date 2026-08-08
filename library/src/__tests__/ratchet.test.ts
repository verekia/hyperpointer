import { beforeEach, describe, expect, test } from 'bun:test'

import { createLeadRatchet } from '../ratchet.js'

describe('lead ratchet', () => {
  let ratchet = createLeadRatchet()
  beforeEach(() => {
    ratchet = createLeadRatchet()
  })

  test('a growing lead is applied one step at a time, and the steps add up to it', () => {
    expect(ratchet.step({ x: 4, y: 0 }).x).toBe(4)
    expect(ratchet.step({ x: 10, y: 0 }).x).toBe(6)
    expect(ratchet.step({ x: 12, y: 0 }).x).toBe(2)
  })

  test('a shrinking lead gives nothing back', () => {
    // The whole reason this exists. A locked pointer has no true heading to correct against, so handing
    // the offset back reads as the camera settling backwards after the hand has already stopped.
    ratchet.step({ x: 20, y: 0 })
    expect(ratchet.step({ x: 12, y: 0 }).x).toBe(0)
    expect(ratchet.step({ x: 3, y: 0 }).x).toBe(0)
    expect(ratchet.step({ x: 0, y: 0 }).x).toBe(0)
  })

  test('a lead that comes back the other way is counted from zero, not from where it was', () => {
    // Otherwise the first frame of a reversal pays for the whole distance between the old lead and the new
    // one, which is a visible kick the samples never asked for.
    ratchet.step({ x: 20, y: 0 })
    expect(ratchet.step({ x: -5, y: 0 }).x).toBe(0)
    expect(ratchet.step({ x: -9, y: 0 }).x).toBe(-4)
  })

  test('the axes ratchet independently, so a turn does not stall the axis that is still growing', () => {
    ratchet.step({ x: 10, y: 10 })
    const step = ratchet.step({ x: 4, y: 18 })
    expect(step.x).toBe(0)
    expect(step.y).toBe(8)
  })

  test('a reset makes the next lead start from nothing rather than arrive all at once', () => {
    ratchet.step({ x: 30, y: -30 })
    ratchet.reset()

    // Without the reset this frame would apply nothing at all, having already "spent" 30 — and after a gap
    // the camera it was spent on is long gone.
    const step = ratchet.step({ x: 5, y: -5 })
    expect(step.x).toBe(5)
    expect(step.y).toBe(-5)
  })

  test('a lead that never shrinks is applied in full, exactly once', () => {
    let applied = 0
    for (const lead of [1, 3, 6, 10, 15]) applied += ratchet.step({ x: lead, y: 0 }).x
    expect(applied).toBe(15)
  })
})
