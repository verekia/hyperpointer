// Every scenario against every device, printed as a table. This is the thing to run while changing the fit:
// the tests say whether anything got worse than it is allowed to be, and this says what actually moved.
//
//   bun run bench                    every scenario, on the four devices the shipped figures are quoted at
//   bun run bench circle             only the scenarios whose name contains "circle"
//   bun run bench --all              every device, including the coarse and sparse ones
//   bun run bench --save before.json
//   bun run bench --diff before.json every number against that run, so a change is read as a change
//
// A tuning change almost always trades one column against another — a stop seen sooner is lead given up on
// the way in, a smoother lead is a later one. `--diff` is there so that trade is visible rather than
// discovered later on somebody's desk.

import { readFileSync, writeFileSync } from 'node:fs'

import { ALL_DEVICES, DEVICES, replay, SCENARIOS, type Device, type Metrics } from './harness.js'

/** The columns worth watching, in the order they are worth watching them. `lower` is which way is better. */
const COLUMNS = [
  { key: 'gain', label: 'gain', digits: 3, lower: true },
  { key: 'error', label: 'err', digits: 2, lower: true },
  { key: 'worstOvershoot', label: 'over', digits: 2, lower: true },
  { key: 'worstLate', label: 'late', digits: 2, lower: true },
  { key: 'worstSizeStep', label: 'size', digits: 3, lower: true },
  { key: 'worstTurnStep', label: 'turn°', digits: 2, lower: true },
  { key: 'worstStep', label: 'step', digits: 3, lower: true },
  { key: 'backwards', label: 'back', digits: 1, lower: true },
  { key: 'worstBackwards', label: 'kick', digits: 2, lower: true },
  { key: 'phantom', label: 'still', digits: 1, lower: true },
  { key: 'worstLead', label: 'lead', digits: 1, lower: false },
  { key: 'bias', label: 'bias', digits: 2, lower: true },
  { key: 'kept', label: 'kept', digits: 1, lower: true },
] as const satisfies readonly { key: keyof Metrics; label: string; digits: number; lower: boolean }[]

const run = (filter: string, devices: readonly Device[]) => {
  const rows: { scenario: string; device: string; metrics: Metrics }[] = []
  for (const scenario of SCENARIOS) {
    if (filter && !scenario.name.toLowerCase().includes(filter.toLowerCase())) continue
    for (const device of devices) {
      rows.push({
        scenario: scenario.name,
        device: device.name,
        metrics: replay({
          path: scenario.path,
          device,
          durationMs: scenario.durationMs,
          scoreAfterMs: scenario.scoreAfterMs,
        }),
      })
    }
  }
  return rows
}

const pad = (value: string, width: number, left = false) => (left ? value.padStart(width) : value.padEnd(width))

const format = (value: number, digits: number) =>
  Number.isFinite(value) ? value.toFixed(digits) : value > 0 ? 'inf' : '-inf'

const main = () => {
  const args = process.argv.slice(2)
  const after = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  const saveTo = after('--save')
  const diffWith = after('--diff')
  const filter = args.find(arg => !arg.startsWith('--') && arg !== saveTo && arg !== diffWith) ?? ''
  const devices = args.includes('--all') ? ALL_DEVICES : DEVICES

  const rows = run(filter, devices)
  if (rows.length === 0) {
    console.log(`no scenario matches "${filter}"`)
    return
  }

  const baseline: Record<string, Metrics> | null = diffWith ? JSON.parse(readFileSync(diffWith, 'utf8')) : null

  const nameWidth = Math.max(...rows.map(row => row.scenario.length), 8) + 2
  const deviceWidth = Math.max(...rows.map(row => row.device.length), 6) + 2
  const cellWidth = 9

  console.log(
    pad('scenario', nameWidth) +
      pad('device', deviceWidth) +
      COLUMNS.map(column => pad(column.label, cellWidth, true)).join(''),
  )

  let previousScenario = ''
  for (const row of rows) {
    const before = baseline?.[`${row.scenario}|${row.device}`]
    const cells = COLUMNS.map(column => {
      const now = row.metrics[column.key]
      const cell = format(now, column.digits)
      if (!before) return pad(cell, cellWidth, true)
      const was = before[column.key]
      const change = now - was
      // Only what moved enough to be worth reading. Sub-percent wander is not a result.
      if (Math.abs(change) <= Math.abs(was) * 0.01 + 1e-9) return pad(cell, cellWidth, true)
      const better = column.lower ? change < 0 : change > 0
      return pad(`${cell}${better ? '↓' : '↑'}`, cellWidth + 1, true)
    })
    const label = row.scenario === previousScenario ? '' : row.scenario
    previousScenario = row.scenario
    console.log(pad(label, nameWidth) + pad(row.device, deviceWidth) + cells.join(''))
  }

  if (saveTo) {
    const out: Record<string, Metrics> = {}
    for (const row of rows) out[`${row.scenario}|${row.device}`] = row.metrics
    writeFileSync(saveTo, `${JSON.stringify(out, null, 2)}\n`)
    console.log(`\nsaved ${rows.length} rows to ${saveTo}`)
  }

  if (baseline) {
    console.log('\n↓ better than the baseline, ↑ worse. Anything unmarked moved by less than a percent.')
  }
}

main()
