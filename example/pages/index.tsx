import { useEffect, useRef, useState } from 'react'

import {
  createPointerBuffer,
  createPointerPredictor,
  DEFAULT_DECAY_MS,
  DEFAULT_LEAD_FRAMES,
  DEFAULT_MAX_LEAD_PX,
} from 'hyperpointer'

import Head from 'next/head'

// Cursor-to-photon rig. Markers chase the OS cursor so a slow-motion recording can measure the gap to it,
// which is the only way to see presentation latency — no clock inside the page can observe it.
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
  leadFrames: number
  capPx: number
  hideCursor: boolean
  hideReported: boolean
  hidePredicted: boolean
}

const CAP_INDICATOR_HOLD_MS = 400
// The leads shown side by side, their colours, and radii that let them nest rather than hide each other.
const COMPARE_LEADS = [1, 2]
const COMPARE_COLOURS: [number, number, number][] = [
  [0.3, 1, 0.3],
  [0.4, 0.7, 1],
]
const RING_RADII = [11, 16]

// Number(null) is 0, so an absent parameter has to be checked for rather than converted — otherwise every
// default silently reads as zero.
const numberParam = (params: URLSearchParams, key: string, fallback: number) => {
  const raw = params.get(key)
  if (raw === null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

const readSettings = (): Settings => {
  const params = new URLSearchParams(window.location.search)
  return {
    // Frames, because the delay being covered is a count of refreshes. Clamped so a URL carrying an old
    // millisecond value cannot ask for half a second of lead.
    leadFrames: Math.min(Math.max(numberParam(params, 'lead', DEFAULT_LEAD_FRAMES), 0), 8),
    capPx: Math.abs(numberParam(params, 'cap', DEFAULT_MAX_LEAD_PX)),
    compare: params.get('compare') === '1',
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

const Rig = ({ compare, leadFrames, capPx, hideCursor, hideReported, hidePredicted }: Settings) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [capping, setCapping] = useState(false)
  const [readout, setReadout] = useState<string[]>([])

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
      const leads = predictors.map(predictor => {
        predictor.pushFrame(frame)
        const lead = predictor.update({ nowMs: frame.nowMs, deltaMs })
        const moving = lead.live >= 1
        return { x: moving ? lead.x * unit : 0, y: moving ? lead.y * unit : 0 }
      })

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
  }, [compare, leadFrames, capPx, hideReported, hidePredicted])

  return (
    <div className={`flex h-screen flex-col bg-neutral-900 text-sm text-white ${hideCursor ? 'cursor-none' : ''}`}>
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

        {/* The OS cursor is drawn by the compositor, not by the page, so it is always at the true position
            and never late. Hiding it leaves only the two markers, which is what a slow-motion recording
            needs to read the lead on its own; showing it is what measures the lag against the truth. */}
        <button
          onClick={() => setParam('compare', compare ? '0' : '1')}
          className={`rounded px-2 py-1 ${compare ? 'bg-emerald-600' : 'bg-white/15'}`}
        >
          compare leads
        </button>

        <button
          onClick={() => setParam('nocursor', hideCursor ? '0' : '1')}
          className={`rounded px-2 py-1 ${hideCursor ? 'bg-emerald-600' : 'bg-white/15'}`}
        >
          hide OS cursor
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
        Move the pointer around. The red square is where the browser says it is; the green circle is where hyperpointer
        thinks it will be by the time this frame reaches the screen. They should sit on top of each other when the hand
        is still, and the circle should sit on the OS cursor while it moves.
      </p>

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
