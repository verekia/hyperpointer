# hyperpointer

Pointer input for real-time browser games: collect it without losing any, and draw the camera where the
hand **will be** rather than where it was.

- **No dependencies**, no DOM at import time, no module state. 5 kB minified, 2.5 kB gzipped.
- Works with a locked pointer, a free cursor, or a touch joystick.
- Every piece is usable on its own.

```bash
bun add hyperpointer   # or npm / pnpm / yarn
```

## The problem

Two separate things make a browser camera feel behind the hand, and they need different fixes.

**Input is dropped or double-counted.** A `pointermove` listener that writes `movementX` into a variable and
a frame loop that reads it are not talking about the same interval. A frame landing between two events
applies the previous delta a second time; a frame spanning several events sees only the last and drops the
rest. Both read as lag, and neither is.

**The frame is old before anyone sees it.** The frame drawn for refresh N is presented one to four refreshes
later. Nothing in the page can make that shorter — the input already arrives as fast as the OS delivers it.
The only thing that closes the gap is drawing where the hand is _going_ to be.

## Quick start

```ts
import { createPointerBuffer, createPointerPredictor } from 'hyperpointer'

const buffer = createPointerBuffer({ maxDeltaPx: 300 })
const predictor = createPointerPredictor()

const stop = buffer.listen() // returns the unsubscribe

const frame = () => {
  requestAnimationFrame(frame)

  const input = buffer.read() // everything since the last frame, and nothing twice
  predictor.pushFrame(input)
  const lead = predictor.update({ nowMs: input.nowMs, deltaMs })

  camera.yaw -= (input.x + lead.x) * radiansPerPixel
  camera.pitch -= (input.y + lead.y) * radiansPerPixel
}
```

That is the whole wiring. `input.x` is the motion that happened; `lead.x` is where it is going.

⚠️ Applied like that, the lead is given back as soon as it shrinks, which reads as the camera settling
_backwards_ after the hand has stopped. Under a locked pointer you almost certainly want
[`createLeadRatchet`](#createleadratchet) — see below.

## Applying the lead

A lead is an absolute offset from where the input actually is, so applying it needs something to apply it
**to**.

**A cursor has that.** The true position keeps arriving, so add the whole lead to it every frame; an
over-eager guess is corrected by the next sample. This is what the [example rig](#the-rig) does.

**A locked pointer does not.** There is no true heading, only a camera that has already been turned. So only
the _growth_ is applied — the lead ratchets the camera further along the way the hand is going, never back:

```ts
import { createLeadRatchet } from 'hyperpointer'

const ratchet = createLeadRatchet()

const step = ratchet.step(lead) // how much to add *this frame*
camera.yaw -= (input.x + step.x) * radiansPerPixel
```

That costs a permanent per-turn gain error (measured at 16–26% of one lead's worth of rotation, kept for the
rest of the session) and buys the property that nothing on screen ever moves against the hand. Under a
locked pointer the wrong heading is not observable; a camera creeping backwards very much is.

Reset both together whenever the pointer stops driving the camera — a menu, an unlocked pointer, a cutscene:

```ts
predictor.reset()
ratchet.reset()
```

Without that, the first frame back fits a curve through motion from before the gap and applies the whole
standing lead in one step.

## Choosing `leadFrames`

`leadFrames` is a count of refreshes, not a duration, because the delay it covers is a count of refreshes —
the same setting has to mean half as long on a 120Hz display.

**Nothing inside a page can measure the right value.** Prediction error against where the hand really went is
measurable for any horizon, but that only says the extrapolator works, never how deep the present queue is.
That number lives on the far side of a boundary the page cannot see across.

So it is judged by eye, on a rig, against the OS cursor — which is drawn by the compositor and is therefore
never late. The default of **1** was chosen that way on a 60Hz panel. Run the [rig](#the-rig), flip between
1 and 2, and pick the one that tracks your cursor.

## API

### `createPointerBuffer(options?)`

Accumulates move events as they arrive; hands over everything since the last read, once.

```ts
const buffer = createPointerBuffer({ maxDeltaPx: 300 })
```

| option       | meaning                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxDeltaPx` | Largest single-event delta accepted, per axis. A pointer-lock recentre can deliver one absurd event that whips the camera round. Clamping on the way in keeps the guard on the glitch rather than on the frame that happened to contain it. Omitted means no clamp. |

- **`listen(target?)`** → unsubscribe. Subscribes to `pointermove`, or `mousemove` where coalesced events are
  not available — never both, since both fire for the same motion. Outside a browser it is a no-op, so it is
  safe to call from code that also renders on a server.
- **`read(nowMs?)`** → `PointerFrame`. Call once per frame, **before any early return** that might skip
  applying it. A delta left unread is a delta applied late, all at once, whenever the consumer comes back.
- **`push(timeStampMs, deltaX, deltaY)`** — feed motion from your own source instead of `listen`.
- **`handle(event)`** — feed one move event. This is what `listen` calls; it takes a plain object too.
- **`clear()`** — throw away what has accumulated without applying it.

`PointerFrame` carries `{ x, y }` (the sum, in raw pointer pixels, **+Y down as the DOM reports it**),
`nowMs`, `ageMs`, and the individual samples as `sampleCount` / `sampleTimes` / `sampleX` / `sampleY`.

`ageMs` is how old the newest sample already was when the frame read it. The browser holds move events until
just before the animation frame, so it is never zero, and anything extrapolating has to start counting there
rather than from now.

> The frame object and its sample arrays are reused every call. Read them, do not keep them.

### `createPointerPredictor(options?)`

Guesses where the pointer will be when the frame reaches the screen.

```ts
const predictor = createPointerPredictor({ leadFrames: 1, maxLeadPx: 100, decayMs: 30 })
```

| option       | default | meaning                                                                                                                                 |
| ------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `leadFrames` | `1`     | How many display refreshes ahead to guess. See [above](#choosing-leadframes).                                                           |
| `maxLeadPx`  | `100`   | How far you are willing to be led, whatever the samples say. Applied to the vector, not to each axis, or a diagonal gets it twice over. |
| `decayMs`    | `30`    | Time constant of the ramp that eases the lead in and out, so a correction is a change of speed rather than a jump.                      |

Exported as `DEFAULT_LEAD_FRAMES`, `DEFAULT_MAX_LEAD_PX`, `DEFAULT_DECAY_MS`.

- **`pushFrame(frame)`** — every sample a `PointerFrame` carried.
- **`push(timeStampMs, deltaX, deltaY)`** — one sample, if you are not using the buffer.
- **`update({ nowMs, deltaMs, ...options })`** → `Lead`. Any option may be overridden per call. `nowMs` must
  be in the same clock as the pushed timestamps — `performance.now()` for DOM event timestamps.
- **`reset()`** — drop the window and everything settled behind it.

`Lead` is `{ x, y, live }`. **`live`** is 1 while input is arriving as often as this device usually manages,
falling to 0 once the silence is long enough to be a stopped hand. To drop the lead the instant the hand
stops, watch `live` — never whether a sample landed this frame. A mouse on a radio leaves a third of frames
empty while moving perfectly steadily.

One predictor per consumer: the sample window and the eased lead are state. Comparing two settings side by
side needs one predictor each.

### `createLeadRatchet()`

Turns an absolute lead into a per-frame increment that only ever grows. See
[Applying the lead](#applying-the-lead).

- **`step(lead)`** → `{ x, y }`, how much to add this frame. Call it with **every** lead, including shrinking
  ones — the frames it returns zero for are what make it a ratchet.
- **`reset()`** — forget how far it has led.

### `createStickReader()`

The buffer's job for a virtual joystick, and it exists for the same reason. Most report the delta of one
touch event, cleared by a timeout rather than by anything that knows about frames — so a frame between two
events applies a delta twice and a frame spanning several drops all but the last.

The fix is easier here, because a stick knows where it is. The change in its position across a frame is
exactly that frame's motion, however many events went into it, and it cannot be applied twice because
reading it moves the mark.

```ts
const stick = createStickReader()

// per frame, before any early return
const moved = stick.read(joystick) // { identifier, current: { x, y } }
camera.yaw -= moved.x * radiansPerPixel
```

A different `identifier` is a different stroke: the gap between where one finger lifted and the next landed
is not motion. Lifting and touching again inside the joystick's own reset delay leaves the old position in
place, which is why the identifier is what separates strokes rather than whether there is a position.

- **`read(stick)`** → `{ x, y }` travelled since the last call.
- **`reset()`** — drop the mark, so a consumer coming back does not apply the gap it was away for.

## How the prediction works

The lead is a **least-squares quadratic fit** through the raw samples of the last 40ms, not a smoothed
velocity. A velocity estimator is systematically late: it lags a ramp by its own smoothing, so it under-leads
the whole accelerating half of a flick and is still near full lead once the hand is already still. A
quadratic carries the acceleration in its curvature, which is what a flick is almost entirely made of.

**One predictor for both axes, not one per axis.** Seen one axis at a time, the extremum of a circling hand
is indistinguishable from a hand that is stopping: its travel across the window goes to zero, so the speed
gate reads a crawl, the direction guard has no direction, and the stop clamp cuts the horizon to nothing.
All three are right for a flick that ends and all three are wrong here — they cancel exactly the inward part
of the guess, which throws the lead off the outside of the circle. In 2D none of them fire, because a
circling hand never slows and never turns around. It turns.

So the extrapolation follows an **arc**, not a straight line. Speed and heading come from the fit; the turn
rate is measured off the path as two chords, because over a wide arc a parabola fits the curvature badly.
The arc degenerates to the straight line as the turn rate goes to zero, so straight motion is bit-identical.

**Braking is believed sooner than the rest of the fit, and read two ways.** Lead that turns out not to have
been needed has to be handed back, and handing it back walks the view backwards under the hand; lead that was
never taken is only the lateness the library exists to remove. So the two are not held to the same standard —
evidence that the hand is slowing is acted on as it arrives, evidence that it is speeding up goes on being
settled slowly. The two readings are the curvature within the window, and the fitted speed changing across
frames: the first is a second derivative over a 40ms span and dies on a device reporting four times per
window, the second differences first derivatives over several frames and still reads that hand at four times
its own noise. Whichever brakes harder wins, so a thick window is unaffected and a thin one gets a stop it
would otherwise never have seen.

**Most of the overshoot was never in the fit — it was the ramp behind it.** A first-order lag trails its
target by its own time constant times how fast that target is moving, and coming off a flick the target falls
faster than at any other time. That lag is a known quantity rather than something to be differentiated out of
a noisy signal, so it is subtracted outright instead of being filtered away, and the smoothing a shaky device
depends on is kept whole. On a hand at constant speed there is nothing to subtract and the guess is
unchanged, bit for bit.

The rest is mostly about not believing noise:

- **Below a crawl there is no lead at all.** Whole mouse counts are all a slow hand produces, and a fit over
  four of them is mostly quantisation.
- **The parabola is believed only as far as the bend stands above the noise floor** — how hard a path of
  whole counts appears to bend when it is dead straight — and slides back to the straight line as that
  margin closes. Sample count is the wrong question: it counts the samples that carried motion, so a fast
  mouse at the start of a flick looks as thin as a slow device, which is exactly when the bend matters most.
- **Device quiet is tolerated before it counts as stopping.** A wired mouse reports every millisecond; one on
  a radio reports in bursts and can say nothing for twenty. Reading that as a stop flickered the lead
  four-fold on a Bluetooth mouse while the hand moved perfectly steadily. What that quiet is gets learned per
  device — but only from silences the hand was moving through. A silence long enough to have been judged a
  stop teaches nothing, or every pause the user makes buys the flick after it a longer one: a quarter-second
  pause was worth 45px of travel the hand never made, and 23 frames of it.
- **A frame that learns nothing does not become bolder.** Once the silence runs past what this device is
  known to keep, the guess may hold and it may fade, but it may not grow. A trackpad hands over one coalesced
  sample per frame, so the frame after the hand lifts carries no samples and no motion at all — and the lead
  grew a fifth on it, which is the one frame the eye gets before freshness starts discounting it.
- **A hitch is not a change of refresh interval**, and the age of the newest sample is averaged rather than
  taken raw — a few milliseconds of horizon is pixels of lead on a hand doing nothing new.
- **The guess is never led past its own reversal.** A quick shake turns round before the horizon is out, and
  at the moment it is fastest there is no acceleration to give the turn away.

## The rig

`example/` is a cursor-to-photon rig: markers chase the OS cursor so a slow-motion recording can measure the
gap to it. That is the only way to see presentation latency — no clock inside the page can observe it.

```bash
bun i && bun dev
```

The red square is the reported position, the green circle is the prediction, and the OS cursor is the truth
(the compositor draws it, so it is never late). `?compare=1` shows two leads at once; `?nocursor=1`,
`?noreported=1` and `?nopredicted=1` strip the frame down to what you want to read.

## License

MIT
