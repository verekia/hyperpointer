import { useEffect, useRef, useState } from 'react'

import {
  createPointerBuffer,
  createPointerPredictor,
  DEFAULT_DECAY_MS,
  DEFAULT_LEAD_FRAMES,
  DEFAULT_MAX_LEAD_PX,
} from 'hyperpointer'

import Head from 'next/head'

// Cursor-to-photon rig. Markers chase the OS pointer — drawn here as a white dot, see CURSOR_DOT_RADIUS —
// so a slow-motion recording can measure the gap to it, which is the only way to see presentation latency:
// no clock inside the page can observe it.
//
// Getting the input position is not the problem: the frame asked for at one refresh is presented one to
// four refreshes later, and the hand has moved by then. Prediction is the only thing that closes that, and
// a cursor is where it can be judged, because the real position keeps arriving to be compared against.
//
// The green marker runs the library on its shipped defaults. It does not, however, apply the lead the way
// a locked-pointer camera does. A camera keeps the lead it was given, because it has no true heading to
// return to (that is what createLeadRatchet is for); the rig has the cursor, so the whole lead is applied,
// and it is dropped the moment the hand stops rather than faded out. Keeping it here would only walk the
// marker away from the cursor the rig is supposed to be measured against, and fading it out would put a
// drift on screen that reads as neither the lead nor the truth.
//
// The browser's getPredictedEvents is not among the markers: it was offered on 30% of events here, and a
// lead that exists a third of the time judders between two amounts of lead rather than hiding either.

type Settings = {
  compare: boolean
  /** The release capture below. Off by default: it exists to read numbers off a real device when something
   * is in question, and the rig's ordinary job is to be looked at rather than read. */
  measure: boolean
  leadFrames: number
  capPx: number
  hideCursor: boolean
  hideReported: boolean
  hidePredicted: boolean
}

const CAP_INDICATOR_HOLD_MS = 400
// One frame of the capture below. Everything is in CSS pixels and milliseconds, as the browser reported
// them, so a pasted capture can be read without knowing anything about this page.
type CaptureRow = {
  t: number
  dt: number
  age: number
  samples: number
  span: number
  /** When the newest sample of this frame was generated, or 0 for a frame that carried none. Speed has to
   * be measured between these and not between frames: a trackpad's samples do not land on frame
   * boundaries, so dividing a frame's travel by the frame interval invents accelerations that are only
   * the sampling wandering. It read as a hand slowing from 22 to 7px/ms that was in fact holding 14.4. */
  stamp: number
  moved: number
  /** What the predictor asked for, before the rig decides whether to draw it. */
  asked: number
  /** What the ring was actually drawn at, which is nothing once the hand reads as stopped. */
  drawn: number
  live: number
}
const HISTORY_FRAMES = 26
// How many frames to keep recording after the release, so the fade is in the capture too.
const TAIL_FRAMES = 6
// Below this the hand was not really going anywhere and the release is not worth keeping.
const MIN_CAPTURE_PX = 8
// The leads shown side by side, their colours, and radii that let them nest rather than hide each other.
const COMPARE_LEADS = [1, 2]
const COMPARE_COLOURS: [number, number, number][] = [
  [0.3, 1, 0.3],
  [0.4, 0.7, 1],
]
const RING_RADII = [11, 16]

// The OS pointer, re-skinned as a white dot a little inside the green ring's radius.
//
// It is still the OS pointer: a cursor image is handed to the window server and drawn by the compositor at
// the true position, exactly as the arrow was, so it stays the one thing in the frame that is never late.
// Drawing a dot into the canvas instead would draw it at the *reported* position, which is the red square —
// the lag this page exists to show would vanish along with the reference for it.
//
// An arrow is a bad shape to judge alignment against: it is not centred on the position it means, so the
// eye compares a corner to a circle and the answer depends on which way the arrow points. A dot centred on
// the hotspot is the same shape as the markers chasing it, and a slow-motion frame reads as the dot being
// inside the ring, on its edge, or outside it. Smaller than the ring so that the two never touch when they
// agree, which is what makes the gap between them readable at all.
const CURSOR_DOT_RADIUS = 8
const cursorDot = () => {
  const size = CURSOR_DOT_RADIUS * 2 + 4
  const centre = size / 2
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>` +
    `<circle cx='${centre}' cy='${centre}' r='${CURSOR_DOT_RADIUS}' fill='white'/></svg>`
  // Falls back to the ordinary arrow rather than to nothing: a rig with no pointer at all is worse than one
  // with the wrong pointer, and `none` is what the hide button is for.
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${centre} ${centre}, default`
}

// Number(null) is 0, so an absent parameter has to be checked for rather than converted — otherwise every
// default silently reads as zero.
const numberParam = (params: URLSearchParams, key: string, fallback: number) => {
  const raw = params.get(key)
  if (raw === null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

// A capture as plain text, so it can be pasted somewhere and read without this page. Frames are numbered
// from the last one that carried any motion, because that is the moment everything after it is measured
// against: at 0 the hand was still being reported, and anything drawn at 1 or later is the guess standing
// over a hand that has already stopped.
const formatCapture = (rows: CaptureRow[], dpr: number, leadFrames: number, capPx: number) => {
  if (rows.length === 0) return ''
  let lastMoving = -1
  for (let i = 0; i < rows.length; i++) if (rows[i]!.moved > 0) lastMoving = i

  const movingRows = rows.filter((_, i) => lastMoving >= 0 && i <= lastMoving && rows[i]!.live >= 1)
  const movingPeak = movingRows.reduce((peak, r) => Math.max(peak, r.asked), 0)
  const afterRows = rows.filter((_, i) => i > lastMoving)
  const flash = afterRows.filter(r => r.drawn > 0)

  const head = [
    `hyperpointer capture — lead=${leadFrames}f cap=${capPx}px dpr=${dpr} ua=${
      typeof navigator === 'undefined' ? '?' : navigator.userAgent
    }`,
    `peak asked while the hand was still reporting: ${movingPeak.toFixed(1)}px`,
    `drawn after the last reported motion: ${
      flash.length === 0
        ? 'nothing'
        : `${flash.map(r => r.drawn.toFixed(1)).join(', ')}px over ${flash.length} frame(s)`
    }`,
    '',
    'frame     dt    age   n   span     gap   moved  px/ms   asked   drawn   live',
  ]
  // Sample to sample, not frame to frame — see CaptureRow.stamp.
  let previousStamp = 0
  const body = rows.map((r, i) => {
    const label = lastMoving < 0 ? String(i) : `${i - lastMoving > 0 ? '+' : ''}${i - lastMoving}`
    const gap = r.stamp > 0 && previousStamp > 0 ? r.stamp - previousStamp : 0
    if (r.stamp > 0) previousStamp = r.stamp
    return [
      label.padStart(5),
      r.dt.toFixed(1).padStart(7),
      r.age.toFixed(1).padStart(7),
      String(r.samples).padStart(4),
      r.span.toFixed(1).padStart(7),
      gap.toFixed(1).padStart(8),
      r.moved.toFixed(1).padStart(8),
      (gap > 0 ? r.moved / gap : 0).toFixed(2).padStart(7),
      r.asked.toFixed(1).padStart(8),
      r.drawn.toFixed(1).padStart(8),
      r.live.toFixed(2).padStart(7),
    ].join('')
  })
  return [...head, ...body].join('\n')
}

const readSettings = (): Settings => {
  const params = new URLSearchParams(window.location.search)
  return {
    // Frames, because the delay being covered is a count of refreshes. Clamped so a URL carrying an old
    // millisecond value cannot ask for half a second of lead.
    leadFrames: Math.min(Math.max(numberParam(params, 'lead', DEFAULT_LEAD_FRAMES), 0), 8),
    capPx: Math.abs(numberParam(params, 'cap', DEFAULT_MAX_LEAD_PX)),
    compare: params.get('compare') === '1',
    measure: params.get('measure') === '1',
    hideCursor: params.get('nocursor') === '1',
    hideReported: params.get('noreported') === '1',
    hidePredicted: params.get('nopredicted') === '1',
  }
}

const setParam = (key: string, value: string) => {
  const params = new URLSearchParams(window.location.search)
  params.set(key, value)
  window.location.search = params.toString()
}

const Rig = ({ compare, measure, leadFrames, capPx, hideCursor, hideReported, hidePredicted }: Settings) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [capping, setCapping] = useState(false)
  const [readout, setReadout] = useState<string[]>([])
  const [capture, setCapture] = useState<{ rows: CaptureRow[]; dpr: number } | null>(null)
  const [copied, setCopied] = useState(false)

  // C copies, X clears. Reaching for the button is not an option: the pointer has to cross the window to
  // get there, which is another flick and another release, and the capture being reached for is overwritten
  // before the click lands. The keyboard is the only way to take a reading without disturbing it.
  useEffect(() => {
    if (!measure) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'c' && capture) {
        navigator.clipboard?.writeText(formatCapture(capture.rows, capture.dpr, leadFrames, capPx))
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }
      if (key === 'x') setCapture(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [capture, measure, leadFrames, capPx])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false })
    if (!gl) return

    // Sized from the same rectangle the pointer is measured against. clientWidth and clientHeight are whole
    // numbers while the box they round is not, and the vertical flip below divides by this height — so
    // taking the size from one and the origin from the other slides every marker off the cursor by however
    // much the layout was rounded by. A rig for measuring where things are must not be a pixel out itself.
    const resize = () => {
      const box = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(box.width * devicePixelRatio))
      canvas.height = Math.max(1, Math.round(box.height * devicePixelRatio))
    }
    resize()
    // Not just on window resize: the row of buttons above can change height on its own — a font arriving,
    // a label growing — and a stale backing size is the same error again.
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    // Scissor rectangles are all a clear can draw, so the shapes are composed from them — including the
    // circle, which is a ring of small ones. Both shapes are open in the middle, so two markers sitting at
    // the same point stay individually readable.
    const unit = devicePixelRatio
    const rect = (x: number, y: number, w: number, h: number, color: [number, number, number]) => {
      // Both edges are rounded, rather than the corner and the size separately. Rounding those apart moves
      // the shape by up to a pixel instead of only resizing it, and these are meant to sit on the cursor.
      const left = Math.round(x)
      const right = Math.round(x + w)
      // Scissor counts up from the bottom, so the near edge is the far one measured from the other end.
      const bottom = Math.round(canvas.height - (y + h))
      const top = Math.round(canvas.height - y)
      gl.scissor(left, bottom, Math.max(0, right - left), Math.max(0, top - bottom))
      gl.clearColor(color[0], color[1], color[2], 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }

    const strokeSquare = (cx: number, cy: number, size: number, color: [number, number, number]) => {
      const t = 3 * unit
      const half = size / 2
      rect(cx - half, cy - half, size, t, color)
      rect(cx - half, cy + half - t, size, t, color)
      rect(cx - half, cy - half, t, size, color)
      rect(cx + half - t, cy - half, t, size, color)
    }

    // Enough blocks that neighbours touch at this radius, so the ring closes without drawing more of them
    // than it needs to.
    const ring = (cx: number, cy: number, radius: number, color: [number, number, number]) => {
      const t = 3 * unit
      const r = radius * unit
      const segments = Math.max(16, Math.ceil((2 * Math.PI * r) / t))
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2
        rect(cx + Math.cos(angle) * r - t / 2, cy + Math.sin(angle) * r - t / 2, t, t, color)
      }
    }

    // The whole wiring, and all of it: collect events as they arrive, drain them once per frame, hand the
    // samples to the predictor, ask it where the pointer is going.
    //
    // Comparing shows several leads at once, each with its own predictor, because the ramp and everything
    // settled behind it are state and one instance cannot answer for two settings. Which lead is right is
    // how many refreshes the machine takes to put a frame on screen, and nothing inside a page can see
    // that — so it is judged by eye against the OS cursor, and judging two side by side is a different
    // task from judging one and remembering it. The rings nest when they agree and separate when they do
    // not, which is the whole reason for the differing radii.
    const buffer = createPointerBuffer()
    const shownLeads = compare ? COMPARE_LEADS : [leadFrames]
    const predictors = shownLeads.map(lead =>
      createPointerPredictor({ leadFrames: lead, maxLeadPx: capPx, decayMs: DEFAULT_DECAY_MS }),
    )
    const stopListening = buffer.listen()

    // The rig needs the true cursor position as well as the motion, which is the one thing a delta source
    // cannot give it. A camera under a locked pointer has no such reference, and that is exactly the
    // difference this page exists to show.
    let posX = 0
    let posY = 0
    let hasPosition = false

    const onMove = (e: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect()
      posX = (e.clientX - bounds.left) * devicePixelRatio
      posY = (e.clientY - bounds.top) * devicePixelRatio
      hasPosition = true
    }
    window.addEventListener('pointermove', onMove)

    // Enough either side of a release to see the guess climb, hold and let go.
    const history: CaptureRow[] = []
    let wasLive = false
    let runPeak = 0
    let tail = -1

    let raf = 0
    let lastReadout = 0
    let lastFrameAt = performance.now()
    // Held briefly so the indicator reads as a light coming on rather than a flicker.
    let lastCappedAt = 0

    const draw = () => {
      raf = requestAnimationFrame(draw)

      const frame = buffer.read()
      const deltaMs = frame.nowMs - lastFrameAt
      lastFrameAt = frame.nowMs

      gl.disable(gl.SCISSOR_TEST)
      gl.clearColor(0.05, 0.05, 0.06, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.enable(gl.SCISSOR_TEST)

      // Deltas arrive in CSS pixels and the canvas is in device pixels, so the lead is scaled to match.
      // Updated every frame either way — the predictor's freshness and frame estimate are state.
      //
      // A lead over a hand that is not moving is a lie the cursor is standing right next to, so it goes to
      // nothing at once rather than fading: what a recording shows is the marker leading or the marker
      // being right, never a drift between the two that reads as neither.
      //
      // Whether the hand is moving is the predictor's to say, not this frame's. Asking whether a sample
      // landed since the last frame looks equivalent and is not: a mouse on a radio leaves a third of
      // frames empty while moving perfectly steadily, and this snapped the marker onto the cursor and back
      // out again on every one of them.
      // The first predictor's raw answer, kept aside for the capture below: what it asked for, and how
      // alive it thought the hand was. The rings draw the applied figure, which is not the same number the
      // moment the hand stops — and telling those two apart is the whole point of capturing anything.
      let askedPx = 0
      let live = 1
      const leads = predictors.map((predictor, index) => {
        predictor.pushFrame(frame)
        const lead = predictor.update({ nowMs: frame.nowMs, deltaMs })
        const moving = lead.live >= 1
        if (index === 0) {
          askedPx = Math.hypot(lead.x, lead.y)
          live = lead.live
        }
        return { x: moving ? lead.x * unit : 0, y: moving ? lead.y * unit : 0 }
      })

      // A release is the one moment worth reading off a real device: the hand has stopped and the guess has
      // not caught up yet, and every figure that decides how long that lasts — how old the samples were,
      // how many arrived, how far apart — is a property of the machine rather than of the model. Recording
      // is a ring write per frame; nothing reaches React until a release has finished playing out. Off
      // unless asked for, so the rig a recording is pointed at is doing nothing but drawing markers.
      if (measure) {
        const spanMs = frame.sampleCount > 1 ? frame.sampleTimes[frame.sampleCount - 1]! - frame.sampleTimes[0]! : 0
        history.push({
          t: frame.nowMs,
          dt: deltaMs,
          age: frame.ageMs,
          samples: frame.sampleCount,
          span: spanMs,
          stamp: frame.sampleCount > 0 ? frame.nowMs - frame.ageMs : 0,
          moved: Math.hypot(frame.x, frame.y),
          asked: askedPx,
          drawn: Math.hypot(leads[0]!.x, leads[0]!.y) / unit,
          live,
        })
        if (history.length > HISTORY_FRAMES) history.shift()

        const isLive = live >= 1
        if (isLive) runPeak = Math.max(runPeak, askedPx)
        if (wasLive && !isLive) {
          // Only worth keeping if the hand was actually going somewhere, or every twitch fires one.
          if (runPeak >= MIN_CAPTURE_PX) tail = TAIL_FRAMES
          runPeak = 0
        }
        wasLive = isLive
        if (tail > 0) {
          tail--
        } else if (tail === 0) {
          tail = -1
          setCapture({ rows: history.slice(), dpr: devicePixelRatio })
        }
      }

      if (hasPosition) {
        // The cursor gives a true position to fall back on, so the whole lead is applied rather than only
        // its growth: an over-eager guess is corrected by the next sample, which is not true of a camera.
        // Either marker can be taken away to measure the other against the OS cursor on its own, which is
        // the only reference in the frame that is never late.
        if (!hideReported) strokeSquare(posX, posY, 46 * unit, [1, 0.25, 0.25])
        if (!hidePredicted) {
          // Widest first, so a smaller ring landing inside a larger one stays visible.
          for (let i = leads.length - 1; i >= 0; i--) {
            ring(posX + leads[i]!.x, posY + leads[i]!.y, RING_RADII[i] ?? 11, COMPARE_COLOURS[i] ?? [0.3, 1, 0.3])
          }
        }
      }

      const leadingPx = Math.hypot(leads[0]!.x, leads[0]!.y) / unit
      if (leadingPx >= capPx - 0.5) lastCappedAt = frame.nowMs

      if (frame.nowMs - lastReadout > 250) {
        lastReadout = frame.nowMs
        setCapping(frame.nowMs - lastCappedAt < CAP_INDICATOR_HOLD_MS)
        setReadout([
          `lead ${leadFrames}f = ${Math.round(leadFrames * deltaMs)}ms · frame ${deltaMs.toFixed(1)}ms`,
          compare
            ? `leading ${leads.map((l, i) => `${shownLeads[i]}f ${Math.round(Math.hypot(l.x, l.y) / unit)}px`).join('  ')}`
            : `leading ${String(Math.round(leadingPx)).padStart(4)}px of ${capPx}px`,
          `sample age ${frame.ageMs.toFixed(1)}ms`,
        ])
      }
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      stopListening()
      window.removeEventListener('pointermove', onMove)
    }
  }, [compare, measure, leadFrames, capPx, hideReported, hidePredicted])

  return (
    <div
      className={`flex h-screen flex-col bg-neutral-900 text-sm text-white ${hideCursor ? 'cursor-none' : ''}`}
      style={hideCursor ? undefined : { cursor: cursorDot() }}
    >
      <div className="flex flex-wrap items-center gap-2 p-2">
        <span className="flex items-center gap-1">
          {[0, 1, 2, 3, 4].map(frames => (
            <button
              key={frames}
              onClick={() => setParam('lead', String(frames))}
              className={`rounded px-2 py-1 ${leadFrames === frames ? 'bg-emerald-600' : 'bg-white/15'}`}
            >
              {frames}
            </button>
          ))}
          <span className="text-white/50">frames lead</span>
        </span>

        <span className="flex items-center gap-1">
          {[40, 80, 100, 160, 320].map(px => (
            <button
              key={px}
              onClick={() => setParam('cap', String(px))}
              className={`rounded px-2 py-1 ${capPx === px ? 'bg-emerald-600' : 'bg-white/15'}`}
            >
              {px}
            </button>
          ))}
          <span className="text-white/50">px cap</span>
        </span>

        <span
          className={`rounded px-2 py-1 font-mono font-bold ${
            capping ? 'bg-red-500 text-white' : 'bg-white/5 text-white/25'
          }`}
        >
          CLAMPED
        </span>

        {/* The OS pointer — the white dot — is drawn by the compositor, not by the page, so it is always at
            the true position and never late. Hiding it leaves only the two markers, which is what a
            slow-motion recording needs to read the lead on its own; showing it is what measures the lag
            against the truth. */}
        <button
          onClick={() => setParam('compare', compare ? '0' : '1')}
          className={`rounded px-2 py-1 ${compare ? 'bg-emerald-600' : 'bg-white/15'}`}
        >
          compare leads
        </button>

        <button
          onClick={() => setParam('measure', measure ? '0' : '1')}
          className={`rounded px-2 py-1 ${measure ? 'bg-emerald-600' : 'bg-white/15'}`}
        >
          measure releases
        </button>

        <button
          onClick={() => setParam('nocursor', hideCursor ? '0' : '1')}
          className={`rounded px-2 py-1 ${hideCursor ? 'bg-emerald-600' : 'bg-white/15'}`}
        >
          hide pointer dot
        </button>

        {/* The legend doubles as the switch for each marker: a marker on its own against the OS cursor is
            the cleanest reading there is, since the pair sitting next to each other invites reading the
            gap between them instead of the gap to the truth. */}
        <span className="flex items-center gap-2 font-mono text-xs">
          <button
            onClick={() => setParam('noreported', hideReported ? '0' : '1')}
            className={`rounded px-2 py-1 ${hideReported ? 'bg-white/5 text-white/25 line-through' : 'bg-white/15 text-red-400'}`}
          >
            □ reported
          </button>
          <button
            onClick={() => setParam('nopredicted', hidePredicted ? '0' : '1')}
            className={`rounded px-2 py-1 ${
              hidePredicted ? 'bg-white/5 text-white/25 line-through' : 'bg-white/15 text-green-400'
            }`}
          >
            {compare ? (
              <>
                <span className="text-green-400">○ 1f</span> <span className="text-sky-300">○ 2f</span>
              </>
            ) : (
              '○ predicted'
            )}
          </button>
        </span>

        {/* This page is the library's demo, so the library has to be one click away from it. Pushed to the
            far end rather than left in the row, or it reads as one more toggle. */}
        <a
          href="https://github.com/verekia/hyperpointer"
          target="_blank"
          rel="noreferrer"
          className="ml-auto rounded bg-white/15 px-2 py-1 hover:bg-white/25"
        >
          hyperpointer on GitHub ↗
        </a>
      </div>

      <div className="flex flex-wrap gap-x-4 px-2 pb-1 font-mono text-xs whitespace-pre text-white/60 tabular-nums">
        {readout.map(line => (
          <span key={line.split(' ')[0]}>{line}</span>
        ))}
      </div>

      <p className="px-2 pb-2 text-xs text-white/40">
        Move the pointer around. The white dot is the OS pointer, drawn by the compositor and never late; the red square
        is where the browser says it is; the green circle is where hyperpointer thinks it will be by the time this frame
        reaches the screen. All three should sit on top of each other when the hand is still, and the circle should stay
        around the dot while it moves.
      </p>

      {measure && capture && (
        <div className="mx-2 mb-2 rounded bg-black/40">
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-white/50">
            <span>Last release — frame 0 is the last one that carried motion</span>
            <span className="ml-auto text-white/40">
              press <kbd className="rounded bg-white/15 px-1 py-0.5 text-white/70">C</kbd> to copy,{' '}
              <kbd className="rounded bg-white/15 px-1 py-0.5 text-white/70">X</kbd> to clear
            </span>
            {copied && <span className="rounded bg-emerald-600 px-2 py-0.5 text-white">copied</span>}
          </div>
          <pre className="overflow-x-auto px-2 pb-2 font-mono text-[11px] leading-tight text-white/70 tabular-nums">
            {formatCapture(capture.rows, capture.dpr, leadFrames, capPx)}
          </pre>
        </div>
      )}

      <div className="relative flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      </div>
    </div>
  )
}

const LatencyPage = () => {
  const [settings, setSettings] = useState<Settings | null>(null)

  // After mount, so the prerendered HTML and the first client render agree.
  useEffect(() => setSettings(readSettings()), [])

  return (
    <>
      <Head>
        <title>hyperpointer — cursor-to-photon rig</title>
        <meta
          name="description"
          content="Measure how far ahead of the reported cursor a predicted pointer lead lands."
        />
      </Head>
      {settings && <Rig {...settings} />}
    </>
  )
}

export default LatencyPage
