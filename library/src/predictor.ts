// The frame drawn for refresh N is presented one to four refreshes later, and the hand has moved by then.
// Leading by the motion expected over that gap is the only thing that closes it, since the input itself
// already arrives as fast as the OS delivers it.
//
// What it returns is a lead in pointer pixels, on both axes, and nothing else. It knows nothing about what
// the pixels turn into — how far a pixel rotates a camera, whether one axis is damped against the other,
// which of the two a caller even uses. All of that is the caller's, and keeping it there is what makes the
// guess reusable: the cap in particular applies to the vector, so a caller that spends only one axis of it
// is throwing away lead it paid for.
//
// The lead is a least-squares fit through the raw samples of the last WINDOW_MS, not a smoothed velocity.
// A velocity estimator is systematically late: it lags a ramp by its own smoothing, so it under-leads the
// whole accelerating half of a flick and is still near full lead once the hand is already still. A
// quadratic carries the acceleration in its curvature, which is what a flick is almost entirely made of.
//
// **One predictor for both axes, not one per axis.** Seen one axis at a time, the extremum of a circling
// hand is indistinguishable from a hand that is stopping: its travel across the window goes to zero, so
// the speed gate reads a crawl, the direction guard has no direction, and the stop clamp cuts the horizon
// to nothing. All three are right for a flick that ends and all three are wrong here — they cancel exactly
// the inward part of the guess, which is why circling used to throw the lead outwards. In 2D none of them
// fire, because a circling hand never slows and never turns around. It turns.
//
// The same mistake waits one level in, where the path is split into along and across. Along the heading
// alone a corner and a stop are again the same event — the speed the hand had is going away — and a corner
// takes it away harder and sooner than any stop does, so a hand turning a right angle at speed had the
// guess asked for nothing at all on the frame the corner entered the window. The answer is the same as
// before: look at the other axis. A hand coming to a stop pushes straight back along its path; a hand
// turning pushes sideways, and through a right angle a hundredth of the bend pointed back along the path
// and the rest of it across.
//
// So the extrapolation follows an arc rather than a straight line. Speed and heading come from the fit;
// the turn rate is measured off the path, because over a wide arc a parabola fits the curvature badly but
// the heading of the window's newer half against its older half is just two chords. The arc degenerates to
// the straight line as the turn rate goes to zero, so straight motion is bit-identical.
//
// **The turn is believed on its own evidence, and on several readings of it.** It used to be multiplied by
// how far the parabola was believed as well, which is a worse measurement of the same thing — on a window
// holding four samples it sits near a half — and two half-open gates left the arc bending at a quarter of
// the rate the hand was turning. A lead that lags the heading on a circle points outwards, so that is a
// marker orbiting outside the circle the hand drew: 20px outside a 120px one.
//
// What replaced it is more evidence rather than a lower bar. A hand going round turns the same way on every
// frame while quantisation flips sign, so the readings are averaged before they are judged, and the noise on
// the average falls with the root of how many independent windows went into it. A reading that contradicts a
// turn already believed is taken at once instead, because a hand can start going round the other way and
// averaging across that says it is doing neither.
//
// **And the horizon is bounded by how far the path turns over it.** Past about a quarter turn the answer is
// mostly the turn rate, which is the noisiest thing here, and the chord being asked for has stopped growing
// with the horizon and started coming back towards the hand — so a wobble in the rate moves the guess around
// the circle rather than along it. Unbounded, a hand stirring a small circle quickly came apart as the lead
// setting went up: at three refreshes the guess sat 58px off a 25px circle, two diameters from anywhere the
// hand goes. Bounded, the answer stops growing with the setting instead of getting worse with it — what a
// longer lead cannot buy, it no longer spends.
//
// Freshness is the only stop signal once the hand has already stopped. A stopped pointer sends nothing, so
// the lead fades out over STOP_MS rather than sailing on at the last fitted speed.
//
// **A hand doubling back is a different event from a hand going round, and telling them apart is the heading
// the last one is remembered as.** Guessing past a reversal is guessing at a path the samples cannot show, so
// how long this hand has been going one way bounds how far ahead it is read — which makes that memory load
// bearing, and it was wrong in both directions at once.
//
// It lagged, so a turn read as a reversal. The memory covers twenty-five milliseconds and a hand stirring a
// small circle turns eighty degrees in that time, so the heading it was judged against was eighty degrees
// stale before any noise arrived and the last ten came free — a hand going steadily round therefore turned
// back several times a lap, and the interval between those readings bounded the horizon. It is carried round
// by the turn the path is already believed to be making now, the same rotation the eased lead itself is
// carried by, so only a hand that genuinely leaves the arc reverses. A path that is not turning is carried by
// nothing, and straight motion is untouched.
//
// And it lingered, so one reversal was counted as two. Eased towards the new heading it only closes half the
// gap in a frame, and half of a half turn is still behind — so the frame after a reversal reversed again, and
// measured the interval between a reversal and itself. That is a period of nothing, and a horizon bounded by
// a fraction of it is no horizon: a zigzag lost its lead outright at every corner and spent five more frames
// earning it back, exactly while the hand was up to full speed on the new leg. What a reversal was read
// against is stale the moment it is read, so it is snapped rather than eased.
//
// **Past a certain rate, though, a hand turning back is not something to bound but something to refuse.** The
// bound above shortens the reach of the guess, and shortening the reach of an answer that points the wrong
// way only scales it down. A hand doubling back faster than the window is long puts a cusp inside every
// window, and a parabola through a cusp is not a poor fit to the path — it is a fit to two paths at once, and
// its slope at the newest sample belongs to neither. That is the one shape the guess made worse than no guess
// at all: on the frames either side of a turn it led a shaking hand backwards, and no horizon short of
// nothing fixes a sign.
//
// **Braking is believed on thinner evidence than the rest of the fit, and read two ways.** Lead that turns
// out not to have been needed has to be handed back, and handing it back walks the view backwards under the
// hand; lead that was never taken is only the lateness this whole thing exists to remove. The two are not
// the same mistake, so they are not held to the same standard: everything that says the hand is slowing is
// acted on as it arrives, while everything that says it is speeding up goes on being settled slowly. The
// two readings are the curvature within the window, and the fitted speed changing across frames — the
// first is a second derivative over the span and dies on a thin window, the second differences first
// derivatives over several frames and survives there, and whichever brakes harder is the one taken.
//
// The ramp is the other half of it. A first-order lag trails its target by its own time constant times how
// fast that target is moving, and coming off a flick the target falls faster than at any other time, so
// most of the overshoot was never in the fit at all — it was the smoothing behind it. That lag is a known
// quantity rather than a mystery, so it is subtracted rather than filtered away, and the smoothing a shaky
// device depends on is kept whole.
//
// Below a crawl there is no lead at all. Whole mouse counts are all a slow hand produces, and a fit over
// four of them is mostly quantisation. A caller that keeps what it is given rather than unwinding it keeps
// every upward wobble too, so left in, that noise became rotation for as long as the drag lasted.
//
// **And how fast the hand is going is asked of the window, not of the samples in it.** The two are the same
// question on a hand that is moving, because a moving hand reports throughout the window; they come apart on
// a hand that is not. A hand resting on the mouse still crosses a count boundary now and then, and two of
// those landing three milliseconds apart are a pixel over three milliseconds — a third of a pixel per
// millisecond, thirteen times a gate written to refuse exactly this, and the resting hand got led. The window
// was forty milliseconds long and thirty-seven of them held nothing at all, which is the entire evidence that
// the hand is still, and dividing by the span between two stray counts is what throws it away. So the
// displacement is taken across the window's trailing edge, which needs the newest sample older than the
// window to say where the hand was when it opened. Without one there is no history to read and the span is
// all there is — which is a window a stop has cleared, and a hand starting again is led off its first samples
// as it always was.
//
// The parabola is believed only as far as the path bends more than a path of whole counts appears to bend
// when it is dead straight, and the answer slides back to the straight line as that margin closes. How
// many samples a window holds is the wrong question — it counts the ones that carried motion, so a fast
// mouse at the start of a flick looks as thin as a slow device, which is the moment the bend matters
// most, while a steady drag looks thick when there is no bend there to find. Asking how far the bend
// stands above the noise instead is both more accurate and steadier, and it is the same question whatever
// the device: a hand crossing a mouse pad reads the same on a wired mouse and one on a radio.
//
// **What a count is worth is measured, not assumed.** Every one of those floors is written in units of one
// count, and one count is a pixel only on a mouse at ordinary sensitivity — a low-DPI one steps four, and so
// does anything scaled on the way through by the OS or by a page that is not at a device pixel ratio of 1.
// Assumed, that put every floor four times too low on such a device and its staircase was believed as
// motion. So the count is read off the deltas, which are the only thing that knows: every delta is a whole
// number of counts, so the grid they sit on is their greatest common divisor, and unlike every other
// statistic to hand that reading does not confuse a coarse device with a fast hand.
//
// **And read a second way, because most hardware has no such divisor.** A count is a whole number of pixels
// only when nothing has scaled it on the way through, and something almost always has — an OS pointer curve,
// a sensitivity slider, a device pixel ratio. What the page reads is rounded to whole pixels, so a 3.7px step
// arrives as 4, 4, 3, 4, 4, 3, and the greatest common divisor of those is one. The divisor does not read
// wrong on such a device; it reads nothing at all, and silently falls back to the assumption it was added to
// replace. Every floor then sits a quarter of the way under the noise it exists to stand above, which is the
// same failure as before with none of the same evidence that it is happening.
//
// The other reading needs no divisor. A count is a step the device cannot report between, so every sample
// sits somewhere inside one, and the scatter that leaves about the curve fitted through them is the width of
// the step: a position uniform across a step of width q is off by q over the root of twelve. That is a
// measurement of the grid rather than a search for it, and it is available on every device, on every path,
// whether or not the deltas happen to line up. The two disagree in only one direction — a divisor that fails
// reads small, never large — so the wider of the two is the one believed.
//
// It is worth the most on the hardware most people have. A coarse mouse on a radio was the worst change of
// step on the whole board, seventeen pixels against the eight and a half of a device reporting at the same
// rate whose counts it could read; measured this way it sits with them, and the guess stops adding anything
// to the unevenness the device already has.

import type { PointerFrame } from './pointer.js'

// The tuned defaults, exported so that everything measuring this and everything using it agree: a lead
// measured on a rig only means something if it is the lead the thing being measured actually applies.
export const DEFAULT_LEAD_FRAMES = 1
export const DEFAULT_MAX_LEAD_PX = 100
export const DEFAULT_DECAY_MS = 30

const WINDOW_MS = 40
// The least time a window may cover and still be worth extrapolating from.
const MIN_SPAN_MS = 2
// A hand slower than this does not travel far enough inside the window to be told apart from the
// quantisation of whole mouse counts, so a fit over it reads mostly noise. Below SLOW there is no lead at
// all, and it ramps to the full figure by SURE. Both in pointer pixels per millisecond, measured on the
// path rather than on either axis, so a diagonal is not gated as though it were two slower motions.
const SLOW_PX_PER_MS = 0.08
const SURE_PX_PER_MS = 0.25
// How far a bend, or a turn, has to stand above what quantisation alone would produce before it is taken
// in full. Both are the same question asked of a different part of the fit.
const CURVE_SNR = 2
const TURN_SNR = 2
// How far a chord's heading typically misses by, per count of quantisation at each of its ends, as a
// fraction of the furthest it could ever miss by. A position on a grid is off by a twelfth of a count in
// variance, which works out at about four tenths of the worst case; a twentieth above that is where a
// stalled frame's noise starts being believed as a turn, so this sits just the safe side of it.
const TURN_NOISE = 0.5
// A guess that bends further than this over one horizon is not a turn a hand makes; it is a fit that has
// run away.
const MAX_TURN_RAD = Math.PI / 2
// And how far the path may turn over the horizon before the horizon itself is cut short. Past this the
// answer is mostly the turn rate, which is the noisiest thing in the fit, and the chord being asked for has
// stopped growing with the horizon and started coming back towards the hand — so a wobble in the rate moves
// the guess around the circle rather than along it. Measured on small circles stirred quickly, which is
// where one horizon is most of a lap: at a quarter turn the guess sat 9px off a 25px circle where trusting a
// half turn put it 23px off and trusting the lot put it 58px off, two diameters from anywhere the hand goes.
// Tighter than this starts costing an ordinary tight circle its lead, and buys little.
const MAX_TRUSTED_TURN_RAD = Math.PI / 4
// How long to settle the turn rate the cap above is read from.
const TURN_RATE_MS = 100
// How long the turn readings are averaged over before they are believed. Long enough for the average to be
// worth more than one reading, short enough to follow a hand that changes which way it is going round.
const TURN_TRUST_MS = 120
// And how quickly it gives way when the path starts turning the other way instead.
const TURN_CHANGE_MS = 30
// How sharply the horizon gives way once the path turns further than that over it.
const TURN_CAP_KNEE = 4
// How far off a chord that ends on whole counts can point, and the unit every noise floor below is written
// in: one count. What a count is worth in pointer pixels is the assumption, and it is only one pixel on a
// mouse at ordinary sensitivity — a low-DPI one moves several, and so does any device whose counts are
// scaled on the way through, by the OS or by a page that is not at a device pixel ratio of 1. Every floor is
// then several times too low, and noise gets believed as motion: measured on a mouse reporting four pixels a
// count, the guess swung 28 degrees of heading a frame on a dead straight path and led a crawl it should
// have refused outright.
//
// So the count is measured rather than assumed, and the deltas are the only thing that knows. Every delta a
// device reports is a whole number of counts, so the grid they all sit on is their greatest common divisor —
// the one reading of it that does not care how fast the hand is going. A hand crossing the pad reports 5 and
// 6 and 5, which share nothing but 1; the same hand on a low-DPI mouse reports 20 and 24 and 20, which share
// 4. Sample counts, smallest deltas and every other obvious statistic all say "coarse device" and "fast
// hand" with the same voice, and the difference is the whole point.
const QUANTISATION_PX = 1
// Long enough to hold a few dozen deltas of an ordinary drag, and two of them have to agree before the
// floors move: over one window a hand can be regular enough that its deltas share a factor by luck, and
// twice running it cannot. Learning therefore takes about half a second of motion, during which the counts
// are assumed to be pixels, which is where they started.
const COUNT_WINDOW_MS = 250
// Wider than this is not a count size, it is a caller scaling deltas into something that is not pixels, and
// the floors have no business following it there.
const MAX_COUNT_PX = 16
// How long to settle the scatter reading of the grid into a figure worth using. A count size is a property
// of the device and does not change, so this only has to be long enough that the reading stops wandering:
// one window's scatter is a handful of samples about a curve and swings by a factor of three, while the
// average of a second's worth of them lands within a fifth of the truth on every device measured.
const GRAIN_MS = 400
// A position sitting anywhere inside a step of width q is off by q over the root of twelve, so the scatter
// the samples leave about the curve through them names the step that produced it.
const GRAIN_PER_SD = Math.sqrt(12)
// Deltas are whole counts, so a remainder this far under one is the division coming out even.
const COUNT_EPSILON = 0.05
// How much a least-squares curvature wobbles for a given amount of that quantisation, over a window of a
// given length and sample count. Tuned on a steady drag, where every bit of curvature read is noise.
const ACCEL_NOISE = 20
// 40ms of a 1000Hz mouse is 40 samples. The rest is slack for a long frame; the oldest are dropped, which
// costs nothing because the window is shorter than the buffer.
const CAPACITY = 128
const STOP_MS = 32
// The longest quiet a device is known to keep while still moving decays at this rate per frame that carried
// input, so one unusually long gap does not excuse silence forever. Multiplied by the tolerance before it
// counts. Every device here settles at a frame's worth of quiet or less — the slowest two at 16.7ms and the
// wired mouse and trackpad at none at all — so MAX_QUIET_MS sits above the worst of them with room, and
// well under anything that would be a hand having stopped. It bounds how long a stop can go unnoticed, so
// generosity here is paid for on screen.
const QUIET_DECAY = 0.92
const QUIET_TOLERANCE = 1.5
const MAX_QUIET_MS = 24
const MAX_ELAPSED_MS = 32
const NEGLIGIBLE_PX = 0.05
const FRAME_SMOOTHING = 0.1
// How much longer than the running estimate one frame is allowed to claim the refresh interval is.
const MAX_FRAME_STEP = 1.5
// How long to average the event-delivery lateness over. Long enough to ride out the per-frame wander,
// short enough to follow a machine that genuinely changes its delivery time.
const AGE_SMOOTHING_MS = 120
// How much longer the ramp gets when the window behind the guess is too thin to trust.
const NOISE_EASE = 3
// How far past its own silence the ramp should reach on a device that reports in bursts. A device handing
// over three samples and then saying nothing for a frame moves the guess in steps of whatever arrived,
// however good the fit behind it is, unless the ramp is long enough to bridge its own gaps — and how long
// those gaps are is a property of the device that is already being learned for the stop signal. A device
// that reports every frame has no quiet, so this is nothing on a wired mouse and on a trackpad.
//
// Scaled by how little there is to track, the same way the noise ease above is. Bridging a gap is worth
// doing while the hand is holding its speed and not worth doing while it is coming off a flick, where the
// ramp has to be short or the lead is handed back after the hand has already stopped.
// How long to settle the judgement about whether the path really bends. That judgement also decides how
// hard the lead is smoothed, so left to answer freshly every frame it switches the smoothing on and off.
const CURVE_TRUST_MS = 150
// The same judgement asked about braking alone, and settled far quicker. A hand comes off a flick in about
// a tenth of a second, so a judgement that takes CURVE_TRUST_MS to arrive arrives after the hand has already
// stopped — measured at a lead still pinned to its peak with the hand down to a fifth of its speed.
// Believing braking early is cheap in a way that believing the rest of the fit early is not: braking only
// ever subtracts, so the worst a brake read off noise can do is give up a little lead for a frame, where
// the same mistake made the other way is carried forward as overshoot and has to be handed back.
const BRAKE_TRUST_MS = 25
// The window carries two readings of the same braking, and which one is worth having depends entirely on
// how thickly the device reports. Within the window it is the curvature — a second derivative over the
// span, which on a trackpad letting go of a long drag peaks at 1.4 times its own noise, so it is at most
// part-believed and only for a frame or two. Across frames it is the fitted speed changing, which
// differences two first derivatives over a baseline of several frames, each already averaged over a whole
// window: the same hand on the same device reads there at 4.2 times its noise and is believed outright.
// So the slow device is not one whose braking cannot be seen, only one whose braking cannot be seen in
// the curvature.
//
// How long to average that trend over, and how much it wobbles for a given amount of quantisation over a
// window of a given length and sample count — the same question ACCEL_NOISE answers for the curvature,
// and answered the same way, so it holds across devices rather than being a figure per device.
const TREND_MS = 25
const TREND_NOISE = 3.6
// How far back the heading a reversal is judged against is remembered, and how much of the interval
// between recent reversals may be extrapolated over.
const HEADING_MEMORY_MS = 25
const REVERSAL_HORIZON = 0.4
// How many windows apart a hand's turns have to be before the window between them holds one motion rather
// than two. At one window a cusp sits inside every window and nothing is believed; at two the turns are far
// enough apart that most windows fall between them, and the fit is believed in full. Anything a hand does
// deliberately — a corner, a zigzag leg, a throw and a correction — is many windows wide and untouched.
const REVERSAL_WINDOWS = 2

// How long the ramp takes to close on what it is pointed at. A guess from a thin window is smoothed harder
// than one from a full one: the ramp costs a good device nothing and is the difference between a usable
// picture and a shaking one on a device that reports a handful of times per window, and there is no telling
// the two apart in advance. Shared, because the ramp and the compensation for the ramp's own lag have to be
// talking about the same number or the correction is for a filter that is not there.
const rampLength = (decayMs: number, confidence: number) => Math.max(decayMs * (1 + NOISE_EASE * (1 - confidence)), 1)

/** Euclid, to a tolerance, because a count is not always a whole number of pixels either. The iteration
 * count is bounded because a pair of deltas that do not converge is a pair to give up on rather than to keep
 * dividing: falling back to a common divisor of one is the assumption this started from. */
const sharedDivisor = (a: number, b: number) => {
  let x = a
  let y = b
  for (let i = 0; i < 8 && y > COUNT_EPSILON; i++) {
    const remainder = x % y
    x = y
    y = remainder
  }
  return y > COUNT_EPSILON ? QUANTISATION_PX : x
}

export type PredictorOptions = {
  /** How many display refreshes ahead to guess. This is a count of refreshes rather than a duration
   * because the delay it covers is a count of refreshes: the same setting has to mean half as long on a
   * 120Hz display. Which number is right is which depth the machine's present queue runs at, and nothing
   * inside a page can see that — measure it on a rig, by eye, against the OS cursor. */
  leadFrames?: number
  /** How far the caller is willing to be led, whatever the samples say — a feel setting, and the caller's
   * to choose. A fit has no ceiling of its own, so a whip banks a quarter turn of rotation on a caller
   * that keeps what it is given. Applied to the vector rather than to each axis, or a diagonal gets it
   * twice over. It is not a safety rail: the guard against a window too thin to extrapolate from is
   * internal, and clamping absurd single samples belongs on the way in (see `createPointerBuffer`). */
  maxLeadPx?: number
  /** Time constant of the ramp that eases the lead in and out, so a correction is a change of speed
   * rather than a jump. */
  decayMs?: number
}

export type PredictorUpdate = PredictorOptions & {
  /** The frame's clock reading, in the same clock as the pushed timestamps — `performance.now()` for DOM
   * event timestamps. */
  nowMs: number
  /** Time since the previous `update`. */
  deltaMs: number
}

export type Lead = {
  x: number
  y: number
  /** 1 while input is arriving as often as this device usually manages, falling to 0 once the silence is
   * long enough to be a stopped hand rather than the gap between reports. A caller wanting to drop the
   * lead the moment the hand stops should watch this, never whether a sample landed this frame: a mouse on
   * a radio leaves a third of frames empty while moving perfectly steadily. */
  live: number
}

export type PointerPredictor = ReturnType<typeof createPointerPredictor>

/**
 * One predictor per consumer, covering both axes: the sample window and the eased lead are state, and two
 * callers sharing them would each be fed the other's motion. Comparing two settings side by side likewise
 * needs one predictor each — a single instance cannot answer for both.
 */
export const createPointerPredictor = (options: PredictorOptions = {}) => {
  const defaultLeadFrames = options.leadFrames ?? DEFAULT_LEAD_FRAMES
  const defaultMaxLeadPx = options.maxLeadPx ?? DEFAULT_MAX_LEAD_PX
  const defaultDecayMs = options.decayMs ?? DEFAULT_DECAY_MS

  const times = new Float64Array(CAPACITY)
  const xs = new Float64Array(CAPACITY)
  const ys = new Float64Array(CAPACITY)
  let head = 0
  let count = 0
  let cumulativeX = 0
  let cumulativeY = 0

  let leadX = 0
  let leadY = 0
  let frameMs = 16.7
  let smoothedAge = 13
  let msSinceInput = 0
  let quietMs = 0
  let lastSeenNewest = 0
  // How much the window behind the last guess was worth. Drives how hard the guess is smoothed.
  let confidence = 1
  let curveConfidence = 0
  // How far the path is believed to be braking, settled apart from the bend as a whole and much faster.
  let brakeConfidence = 0
  // The fitted speed as it was at the previous guess, and how it has been moving since — the reading of
  // the braking that survives on a device too thin to carry a curvature. Negative marks it as having no
  // previous speed to difference against, which is not the same as a previous speed of zero.
  let lastSpeed = -1
  let speedTrend = 0
  // Believed turn rate of the path, rad/ms, so the eased lead can be carried around with the heading, and
  // how fast the path has lately been turning, which is what bounds how far ahead the turn may be trusted.
  let carriedTurn = 0
  let turnRate = 0
  let turnAverage = 0
  // A hand that has lately been doubling back, and how long it went between doing so. At the moment a
  // shake is fastest it is locally indistinguishable from a hand crossing the pad: same speed, and no
  // acceleration, because the turn is still ahead. Only the memory that it turned round a moment ago
  // separates them, and a memory of events survives that moment where any average does not.
  // The turn the path was believed to be making when the last guess was made. The heading a reversal is
  // judged against is carried round by it, so a hand going round is never read as a hand doubling back.
  let headingTurn = 0
  let headingX = 0
  let headingY = 0
  let msSinceReversal = 1e4
  let reversalPeriodMs = 1e4
  // What one count of this device is worth in pointer pixels, and the two windows of deltas behind that
  // answer. Believed only as far as the assumption it replaces is safe: a device reporting finer than a
  // pixel is quieter than the floors expect, which costs a little sensitivity and can break nothing, so
  // this only ever moves them up.
  let countPx = QUANTISATION_PX
  let countThisWindow = 0
  let countLastWindow = 0
  // The same question asked of the scatter rather than of a shared divisor, for the devices that have no
  // shared divisor to find. Smallest reading wins within a window, because the widest a count can look is
  // when the path itself is not straight, and two windows have to agree before it is believed.
  let grainPx = QUANTISATION_PX
  let gcdPx = QUANTISATION_PX
  let countWindowAt = -1

  const out: Lead = { x: 0, y: 0, live: 1 }

  const observeCount = (delta: number) => {
    const size = Math.abs(delta)
    if (size < COUNT_EPSILON) return
    countThisWindow = countThisWindow === 0 ? size : sharedDivisor(countThisWindow, size)
  }

  /** One coalesced sample: when the motion happened, and how far it went on each axis. */
  const push = (timeStampMs: number, deltaX: number, deltaY: number) => {
    // Once this window's deltas have nothing bigger than a pixel in common there is nothing left to learn
    // from it, which is the case on every device that reports in pixels and costs them a comparison.
    if (countThisWindow === 0 || countThisWindow > QUANTISATION_PX) {
      observeCount(deltaX)
      observeCount(deltaY)
    }
    cumulativeX += deltaX
    cumulativeY += deltaY
    times[head] = timeStampMs
    xs[head] = cumulativeX
    ys[head] = cumulativeY
    head = (head + 1) % CAPACITY
    if (count < CAPACITY) count++
  }

  /** Every sample a `createPointerBuffer` frame carried, in order. */
  const pushFrame = (frame: PointerFrame) => {
    for (let i = 0; i < frame.sampleCount; i++) {
      push(frame.sampleTimes[i]!, frame.sampleX[i]!, frame.sampleY[i]!)
    }
  }

  const clear = () => {
    count = 0
    head = 0
    cumulativeX = 0
    cumulativeY = 0
  }

  // Everything the window has to say about the path: where it is going, how that is changing, and how far
  // it actually went. Positions are centred on the newest sample, so the evaluation point is the origin,
  // the constant term drops out of every answer, and the normal equations stay well conditioned however
  // long the session runs.
  const fit = (horizonMs: number, deltaMs: number, decayMs: number) => {
    const newest = (head - 1 + CAPACITY) % CAPACITY
    const newestT = times[newest]!
    const newestX = xs[newest]!
    const newestY = ys[newest]!

    let s0 = 0
    let s1 = 0
    let s2 = 0
    let s3 = 0
    let s4 = 0
    let xy0 = 0
    let xy1 = 0
    let xy2 = 0
    let yy0 = 0
    let yy1 = 0
    let yy2 = 0
    let pxx = 0
    let pyy = 0
    let travelX = 0
    let travelY = 0
    let span = 0
    let used = 0
    // The first sample too old for the window, if the buffer reaches that far back. It is not fitted — it is
    // there to say where the hand was when the window opened, which the samples inside it cannot.
    let beforeT = 0
    let beforeX = 0
    let beforeY = 0
    let reachesBack = false

    for (let i = 0; i < count; i++) {
      const index = (newest - i + CAPACITY) % CAPACITY
      const u = times[index]! - newestT
      if (-u > WINDOW_MS) {
        beforeT = times[index]!
        beforeX = xs[index]!
        beforeY = ys[index]!
        reachesBack = true
        break
      }
      const px = xs[index]! - newestX
      const py = ys[index]! - newestY
      const u2 = u * u
      s0 += 1
      s1 += u
      s2 += u2
      s3 += u2 * u
      s4 += u2 * u2
      xy0 += px
      xy1 += u * px
      xy2 += u2 * px
      yy0 += py
      yy1 += u * py
      yy2 += u2 * py
      pxx += px * px
      pyy += py * py
      // What the hand actually did over the window, as opposed to what a curve through it says.
      travelX = -px
      travelY = -py
      span = -u
      used++
    }

    if (used < 2) return false
    // Nothing can be extrapolated over a horizon of tens of milliseconds from a window that covers a
    // fraction of one. Coalesced samples can arrive a microsecond apart, and a velocity read off two of
    // those is enormous and meaningless: uncapped it asked for eighteen thousand pixels of lead. This is
    // the library's own floor, not a feel setting — it says only that the samples do not support an
    // answer, where `maxLeadPx` says how far the caller is willing to be led.
    if (span < MIN_SPAN_MS) return false

    // Measured travel, not the fitted figure: the fit is the noisy thing, so trusting it to say how fast
    // the hand is going lets every spike through amplified. Under a crawl the lead is dropped entirely —
    // a caller that keeps what it is given keeps every upward wobble too, so jitter at a slow steady
    // drag accumulates for as long as the drag lasts.
    // Travel is only known to within a count, and the gate below is a speed tuned against a device whose
    // counts are pixels — so the extra uncertainty of a wider one comes off the travel before it is read.
    // Left in, a hand well under the gate reads several times over it on a low-DPI mouse whenever two counts
    // happen to land close together, and a crawl gets led by a fit that is entirely staircase. Taking it off
    // the travel rather than putting it on the threshold is what keeps an ordinary drag on that device led:
    // four counts across a window are few enough that no curve can be fitted to them and plenty to say how
    // fast the hand is going.
    //
    // Over the window's own length, not over whatever the samples in it happen to span. The two are the same
    // thing on a hand that is moving, because a moving hand reports throughout; they come apart on a hand
    // that is not. A still hand crosses a count boundary now and then, and two of those landing a few
    // milliseconds apart span a few milliseconds — so a pixel of tremor divided by three milliseconds read as
    // a third of a pixel per millisecond, thirteen times over a gate meant to refuse it, and a hand resting
    // on the mouse got led. The window was 40ms long and 37ms of it held nothing at all, which is the whole
    // evidence that the hand is still, and dividing by the span is exactly what throws it away.
    //
    // So the displacement is taken over the window's trailing edge, which needs the last sample older than it
    // to say where the hand was then — the samples inside cannot, and a sparse device has few of them. That
    // sample sits outside the window, so it is interpolated up to the edge rather than used where it is, or
    // motion from before the window would be counted as motion in it. Without one the buffer does not reach
    // back far enough to know, and the span is all there is: a window cleared by a stop is the flick starting
    // again, and it is led off its first samples as it always was.
    let reach = Math.hypot(travelX, travelY)
    let over = span
    if (reachesBack) {
      const oldestT = newestT - span
      const edge = (newestT - WINDOW_MS - beforeT) / (oldestT - beforeT)
      const edgeX = beforeX + (newestX - travelX - beforeX) * edge
      const edgeY = beforeY + (newestY - travelY - beforeY) * edge
      reach = Math.hypot(newestX - edgeX, newestY - edgeY)
      over = WINDOW_MS
    }
    const travel = Math.max(0, reach - (countPx - QUANTISATION_PX))
    const speed = over > 0 ? travel / over : 0
    const trust = Math.max(0, Math.min(1, (speed - SLOW_PX_PER_MS) / (SURE_PX_PER_MS - SLOW_PX_PER_MS)))
    if (trust === 0) return false

    const m00 = s2 * s4 - s3 * s3
    const m01 = s1 * s4 - s2 * s3
    const m02 = s1 * s3 - s2 * s2
    const detQuadratic = s0 * m00 - s1 * m01 + s2 * m02
    const detLinear = s0 * s2 - s1 * s1
    const canCurve = used >= 3 && Math.abs(detQuadratic) > 1e-9

    // Both readings of the same window: the straight line through it, and the parabola. The straight line
    // is steadier, the parabola is the only one that can see a hand speeding up or turning.
    let straight = 0
    let curved = 0
    let bend = 0
    let level = 0
    const solve = (y0: number, y1: number, y2: number) => {
      straight = Math.abs(detLinear) < 1e-9 ? 0 : (s0 * y1 - s1 * y0) / detLinear
      if (!canCurve) {
        curved = straight
        bend = 0
        return
      }
      curved = (-y0 * m01 + y1 * (s0 * s4 - s2 * s2) - y2 * (s0 * s3 - s1 * s2)) / detQuadratic
      bend = 2 * ((y0 * m02 - y1 * (s0 * s3 - s1 * s2) + y2 * (s0 * s2 - s1 * s1)) / detQuadratic)
      level = (y0 * m00 - y1 * m01 + y2 * m02) / detQuadratic
    }

    solve(xy0, xy1, xy2)
    const straightX = straight
    const curvedX = curved
    const bendX = bend
    const levelX = level
    solve(yy0, yy1, yy2)
    const straightY = straight
    const curvedY = curved
    const bendY = bend
    if (canCurve && used > 3) {
      // How far the samples scatter about the curve drawn through them. A count is a step the device cannot
      // report between, so every reading sits somewhere inside one, and that scatter is the only reading of
      // how wide a count is that does not need the deltas to share a divisor. A grid of width q leaves a
      // standard deviation of q over the root of twelve, so the scatter names the grid.
      const rss =
        pxx -
        (levelX * xy0 + curvedX * xy1 + (bendX / 2) * xy2) +
        (pyy - (level * yy0 + curved * yy1 + (bend / 2) * yy2))
      const spread = Math.sqrt(Math.max(0, rss) / (2 * used - 6))
      grainPx += (spread * GRAIN_PER_SD - grainPx) * (1 - Math.exp(-deltaMs / GRAIN_MS))
    }

    // How far the parabola is worth believing over the straight line: how hard the path bends, against how
    // hard a path of whole mouse counts appears to bend when it is dead straight. Sample count alone was
    // the wrong question — it counts the samples that carried motion, so the start of a flick on a fast
    // mouse looks exactly as thin as a slow device, and that is the moment the bend matters most.
    // How much a least-squares curvature wobbles for this much quantisation over a window this long and
    // this well populated. Every judgement about whether a bend is real is asked against it.
    const bendFloor = (ACCEL_NOISE * countPx) / (span * span * Math.sqrt(used))
    const measured =
      bendFloor > 0 ? Math.max(0, Math.min(1, (Math.hypot(bendX, bendY) / bendFloor - 1) / (CURVE_SNR - 1))) : 0
    // A bend sitting near its own noise floor answers this differently every frame, and the answer decides
    // both which fit to believe and how hard to smooth the result — so left raw it switches the smoothing
    // on and off and the lead lurches each time. A judgement about how much a window is worth must not be
    // the noisiest thing in the calculation. A real flick clears the floor several times over and reaches
    // full trust regardless of this.
    curveConfidence += (measured - curveConfidence) * (1 - Math.exp(-deltaMs / CURVE_TRUST_MS))
    const curveTrust = curveConfidence

    const vx = straightX + (curvedX - straightX) * curveTrust
    const vy = straightY + (curvedY - straightY) * curveTrust

    const speedNow = Math.hypot(vx, vy)
    if (speedNow < 1e-6) return false
    // A fit that has ended up pointing somewhere the window never went is not describing this path.
    if (vx * travelX + vy * travelY <= 0) return false

    const tx = vx / speedNow
    const ty = vy / speedNow

    // Against a heading from a moment ago, carried round by the turn the path is believed to be making, so a
    // hand going round a circle never counts as turning back.
    //
    // A memory that is not carried round is a memory that lags, and on a circle it lags by its own length —
    // a hand stirring a small one turns eighty degrees in the twenty-five milliseconds the memory covers, so
    // the heading it is compared against is eighty degrees stale before any noise is added, and the last ten
    // come free. Then a hand going steadily round reads as a hand turning back several times a lap, the
    // interval between those readings is nothing like a reversal period, and the horizon is bounded by it.
    // Carried, the memory turns with the path and only a hand that genuinely leaves the arc reverses. A path
    // that is not turning is carried by nothing, so straight motion is untouched.
    const carry = Math.max(-MAX_TURN_RAD, Math.min(MAX_TURN_RAD, headingTurn * deltaMs))
    const carriedX = headingX * Math.cos(carry) - headingY * Math.sin(carry)
    const carriedY = headingX * Math.sin(carry) + headingY * Math.cos(carry)
    headingX = carriedX
    headingY = carriedY
    const reversed = headingX * tx + headingY * ty < 0
    if (reversed) {
      reversalPeriodMs = msSinceReversal
      msSinceReversal = 0
    } else {
      msSinceReversal += deltaMs
      // Grows back on its own, so one stray reversal cannot shorten the horizon for good.
      reversalPeriodMs = Math.max(reversalPeriodMs, msSinceReversal)
    }
    if (reversed) {
      // Snapped rather than eased, because the old heading is what the reversal was just read against and
      // keeping any of it says the hand is still going the old way. Eased, a turn through a half circle
      // leaves the average still pointing back on the next frame — the memory only closes half the gap in a
      // frame — so the same reversal is counted twice, and the second reading measures the interval between
      // a reversal and itself. That is a period of nothing, and the horizon is bounded by a fraction of the
      // period: a zigzag lost its lead outright for the frame after every corner and spent five more
      // earning the horizon back, at exactly the moment the hand was up to full speed on the new leg.
      headingX = tx
      headingY = ty
    } else {
      const headingRate = 1 - Math.exp(-deltaMs / HEADING_MEMORY_MS)
      headingX += (tx - headingX) * headingRate
      headingY += (ty - headingY) * headingRate
    }
    const nx = -ty
    const ny = tx

    // How far along its own path the hand goes. Past the point where the fit says it stops, it does not
    // keep going backwards: a guess may say the hand is about to slow or stop, it may not say the hand is
    // about to reverse, because that is a visible kick and the samples do not support it. A real reversal
    // turns the measured travel around within a window and is led normally from there.
    //
    // The curvature term is what makes a flick worth fitting, and it is also the noisiest thing here: a
    // second derivative taken off whole mouse counts wobbles by a few pixels of lead even when the hand is
    // going at a dead constant speed. Subtract what quantisation alone would produce, so constant speed
    // reads as constant and a flick still reads as a flick.
    const bendAlong = bendX * tx + bendY * ty
    // How much of the bend is the hand slowing rather than the hand turning. Seen along the heading alone,
    // a corner is indistinguishable from a stop: the speed in the direction the hand was going collapses,
    // and it collapses harder and sooner than any real stop does. It is the same blind spot a per-axis fit
    // has at the extremum of a circle, one level in — and it has the same answer, which is to look at the
    // other axis. A hand coming to a stop pushes straight back along its path. A hand turning pushes
    // sideways, and a corner is almost entirely sideways: measured through a right angle at speed, a
    // hundredth of the bend pointed back along the path and the rest of it across.
    //
    // Where the bend is too small to have a direction at all this says nothing and must not be allowed to:
    // below its own noise floor it reads as one, which leaves every device too thin to carry a curvature
    // braking exactly as it did before. That is the case the speed trend exists for, and this may not take
    // it away.
    const bendMagnitude = Math.hypot(bendX, bendY)
    const slowing = bendMagnitude > bendFloor ? Math.abs(bendAlong) / bendMagnitude : 1
    const alongRaw = bendAlong * curveTrust
    let alongAcceleration = Math.sign(alongRaw) * Math.max(0, Math.abs(alongRaw) - bendFloor)

    // Braking is judged on its own, against the same noise floor but settled over BRAKE_TRUST_MS rather
    // than CURVE_TRUST_MS, and gated once rather than twice — shrinking the bend by how far it is believed
    // and then taking the whole floor off what is left asks the same question of the same quantity twice,
    // which zeroed the first three frames of every stop.
    //
    // Only ever taken when it brakes harder than the settled reading does, so this can subtract lead and
    // never add it: a stop is seen sooner or exactly as before, never later.
    const brakeMeasured =
      bendAlong < 0 && bendFloor > 0
        ? Math.max(0, Math.min(1, (-bendAlong / bendFloor - 1) / (CURVE_SNR - 1))) * slowing
        : 0
    brakeConfidence += (brakeMeasured - brakeConfidence) * (1 - Math.exp(-deltaMs / BRAKE_TRUST_MS))
    const brakeTrust = brakeConfidence
    if (bendAlong < 0) {
      alongAcceleration = Math.min(alongAcceleration, -Math.max(0, -bendAlong - bendFloor) * brakeTrust)
    }

    // The same braking read across frames instead of within the window: how the fitted speed itself has
    // been moving. Its floor falls off one power of the span rather than two and is divided by the baseline
    // it is differenced over, which is why it survives on a window the curvature cannot be read from at all.
    //
    // Taken by the same rule as everything else here — whichever reading brakes harder wins, so a device
    // thick enough to carry a curvature is unaffected by this and a device that is not gets a stop it would
    // otherwise not have seen. Braking only, so a speed picking up is left to the curvature.
    if (lastSpeed >= 0 && deltaMs > 0) {
      speedTrend += ((speedNow - lastSpeed) / deltaMs - speedTrend) * (1 - Math.exp(-deltaMs / TREND_MS))
    }
    lastSpeed = speedNow
    const trendFloor = (TREND_NOISE * countPx) / (span * Math.sqrt(used) * TREND_MS)
    // The fitted speed falls at a corner as surely as it falls at a stop, and for a reason that has nothing
    // to do with the hand: the straight line through a window that bends is the chord of it, and a chord is
    // shorter than the path. So this is held to the same question as the curvature above — through a right
    // angle the fitted speed dropped by a third with the hand at a dead constant speed throughout.
    if (speedTrend < 0 && trendFloor > 0) {
      const believed = Math.max(0, Math.min(1, (-speedTrend / trendFloor - 1) / (CURVE_SNR - 1))) * slowing
      alongAcceleration = Math.min(alongAcceleration, speedTrend * believed)
    }

    // The straight fit's slope is the speed averaged across the window, which is the speed the hand had
    // half a window ago. On a hand at constant speed that is the same number and the distinction does not
    // arise; into a stop it is the speed the hand has already left behind, and leading from it is worth
    // most of a frame of overshoot on its own. The parabola's slope is the speed at the newest sample, so
    // the gap between the two is what the window says has already been given up. Taken only as far as
    // braking is believed beyond the settled reading, so nothing is subtracted twice.
    const givenUp = Math.min(0, curvedX * tx + curvedY * ty - (straightX * tx + straightY * ty))
    const speedAlong = Math.max(0, speedNow + givenUp * Math.max(0, brakeTrust - curveTrust))

    // Turn rate straight off the path: the heading of the newer half of the window against the heading of
    // its older half, which is two chords rather than a second derivative.
    let turn = 0
    if (used >= 3 && span > 0) {
      const middle = (newest - (used >> 1) + CAPACITY) % CAPACITY
      const oldest = (newest - (used - 1) + CAPACITY) % CAPACITY
      const newX = newestX - xs[middle]!
      const newY = newestY - ys[middle]!
      const oldX = xs[middle]! - xs[oldest]!
      const oldY = ys[middle]! - ys[oldest]!
      const newLength = Math.hypot(newX, newY)
      const oldLength = Math.hypot(oldX, oldY)
      if (newLength > 1e-6 && oldLength > 1e-6) {
        const cross = (oldX * newY - oldY * newX) / (newLength * oldLength)
        const dot = (oldX * newX + oldY * newY) / (newLength * oldLength)
        // A chord ending on whole counts can point up to about half a count either side of where it
        // really points, so short chords carry an angle error that is pure quantisation. Off an axis the
        // two axes cross their count boundaries at different moments, the path becomes a zig-zag about
        // the true line, and a turn read straight off it wanders by more than any hand does.
        //
        // So the floor decides how far to believe the angle rather than being taken out of it. Subtracting
        // it is a flat tax: it removes as much from a turn a hand really made as from one only the counts
        // made up, and on a circle a hand does make that came to a third of the turn — which is most of
        // why the guess used to sit outside the circle.
        // Not the worst a count can do to a chord's heading, which is what this used to be, but what it does
        // typically: a position quantised to a grid is off by a twelfth of a count in variance, so a chord
        // with a count of grid at each end points about four tenths of a count over its length away from
        // where it really points. The worst case is two and a half times that, and using it as the divisor
        // of a signal-to-noise ratio asked for a five-sigma turn before believing one — which a 120px circle
        // at a comfortable speed does not produce, and it was left sitting outside the circle for it.
        const floor = TURN_NOISE * countPx * (1 / newLength + 1 / oldLength)
        const angle = Math.atan2(cross, dot)

        // One reading a frame, and a noisy one. What separates a hand going round from a path of whole
        // counts that only looks like it is going round is not how big any single reading was — a slow drag
        // throws up ninety degrees of apparent turn from nothing at all — it is that a real turn goes the
        // same way on every frame and a made-up one flips. So the readings are averaged before they are
        // judged: a circle keeps its whole rate through that, quantisation averages to nothing, and the
        // noise on what is left falls by the root of how many independent windows went into it.
        //
        // Windows overlap, so frames are not independent readings; only a window's worth of new samples is.
        // That is what the count below is, and it is the whole of why this is more evidence rather than a
        // lower bar.
        const rate = angle / (span / 2)
        const independent = Math.max(1, TURN_TRUST_MS / WINDOW_MS)
        const floorRate = floor / (span / 2) / Math.sqrt(independent)
        // A reading that disagrees with a turn already worth believing is news rather than noise, and is
        // taken far sooner — the same asymmetry braking gets, for the same reason: a hand can stop going
        // round one way and start going round the other, and averaging across that says it is doing neither.
        // A figure eight does it twice a lap, and carrying the old way across each one rotated the lead
        // against the hand for a tenth of a second at a time, which a caller keeping the growth keeps.
        //
        // The test is against a turn that was believed, not against zero, or a straight path — whose
        // readings flip sign every frame and mean nothing — would take the quick road every time and the
        // average would follow the noise it is there to cancel.
        const contradicts = rate * turnAverage < 0 && Math.abs(turnAverage) > floorRate
        turnAverage += (rate - turnAverage) * (1 - Math.exp(-deltaMs / (contradicts ? TURN_CHANGE_MS : TURN_TRUST_MS)))
        const believed =
          floorRate > 0 ? Math.max(0, Math.min(1, (Math.abs(turnAverage) / floorRate - 1) / (TURN_SNR - 1))) : 0
        // Not gated by how far the parabola is believed as well. The chords are measured off the path
        // precisely because the parabola fits an arc badly, and on a window holding four samples the
        // parabola is the weaker of the two — letting it veto the stronger left the arc bending at a quarter
        // of the rate the hand was turning, which on a circle is a lead that lags the heading, and a lead
        // that lags on a circle points outwards. That is the marker sitting outside the circle.
        turn = turnAverage * believed
        carriedTurn = turn
        headingTurn = turn
      }
    }

    // How hard to smooth the lead. Read off the bend alone this asks whether the path is straight, and
    // answers a dead-steady cruise with the longest ramp there is — four times decayMs at the exact moment
    // the hand is most likely to come off the flick and the target about to move faster than at any other
    // time. What the ramp needs to know is whether there is anything to track, and braking is something to
    // track whether or not the path bends, so a stop no longer has to drag the ramp along behind it.
    confidence = Math.max(curveTrust, brakeTrust)
    const rampMs = rampLength(decayMs, confidence)
    // Never guess much further ahead than this hand has been going between turning round. Past that the
    // guess is extrapolating through a reversal it has no way to see, and on a quick shake it ran further
    // than the whole width of the motion.
    let horizon = Math.min(horizonMs, reversalPeriodMs * REVERSAL_HORIZON)
    // And nothing at all is believed of a hand turning round faster than the window is long. The cap above
    // bounds how far past the newest sample the guess may reach; this asks the prior question, which is
    // whether the window behind it describes one motion or several. A hand doubling back every 40ms puts a
    // cusp inside every window, and a parabola through a cusp is not a bad fit to the path — it is a fit to
    // two paths at once, and its slope at the newest sample belongs to neither. Shortening the reach of an
    // answer like that only scales down something already pointing the wrong way.
    //
    // Which is why a shake was the one shape the guess made worse than no guess at all: on the frames either
    // side of a turn it led the hand backwards, and no horizon short of nothing fixes a sign. Held to this,
    // a hand shaking faster than the window is left alone — the score comes back to what a caller who never
    // guessed would have had, instead of sitting several percent under it.
    horizon *= Math.max(0, Math.min(1, (reversalPeriodMs / WINDOW_MS - 1) / (REVERSAL_WINDOWS - 1)))
    // Nor further ahead than the path turns a quarter circle over. Past that the answer is mostly the turn
    // rate — the noisiest thing in the fit — and the chord it is asking for has stopped growing with the
    // horizon and started shrinking back towards the hand, so a wobble in the rate moves the guess about the
    // circle rather than along it. It is the same rule as the reversal above, for a hand that is turning
    // rather than doubling back, and it binds on exactly the case that has no answer: a small circle stirred
    // quickly, where one horizon is most of a lap. Left uncapped the sweep was clamped to a quarter turn
    // while the distance went on being the whole arc, so the guess left the circle altogether — 58px off a
    // 25px circle at three frames of lead, which is two diameters away from any point the hand visits.
    // Against a settled reading of the rate, not this frame's. Capping on the raw one hands the horizon the
    // turn estimate's own frame-to-frame wobble, and a horizon that wobbles is a lead whose length wobbles,
    // which is the picture moving backwards under the hand — 2.3px of it on a tight circle, which is the
    // artefact this exists to remove rather than one to introduce. How fast a hand is going round changes
    // over tenths of a second; the noise on reading it changes every frame.
    turnRate += (Math.abs(turn) - turnRate) * (1 - Math.exp(-deltaMs / TURN_RATE_MS))
    if (turnRate > 0) {
      // Eased rather than cut, because a hard ceiling has a knee, and a path whose turn sits on the knee
      // steps across it and back every frame. The shape below leaves a gentle turn alone, takes a sixth off
      // at the point the cap is reached, and settles on the cap itself past it.
      const sweep = (turnRate * horizon) / MAX_TRUSTED_TURN_RAD
      horizon /= (1 + sweep ** TURN_CAP_KNEE) ** (1 / TURN_CAP_KNEE)
    }
    if (alongAcceleration < 0 && speedAlong + alongAcceleration * horizon < 0) {
      horizon = -speedAlong / alongAcceleration
    }
    // Where the hand will be, which is the ordinary kinematic answer.
    const travelled = speedAlong * horizon + 0.5 * alongAcceleration * horizon * horizon

    // The ramp is a first-order lag, so it trails whatever it is pointed at by its own time constant times
    // however fast that target is genuinely moving. Into a stop the target falls at the braking rate over
    // the horizon, and the trailing is worth more than everything else here put together: with the fit
    // reading the stop correctly the target was down to 16px while the lead was still holding 37.
    //
    // How fast the target moves is not a mystery to be differentiated out of a noisy signal — the target is
    // speed over the horizon, so it moves at the acceleration over the horizon, and the acceleration is
    // already here and already gated. Pointing the ramp that far past the hand leaves it arriving on time.
    // A hand at constant speed has no acceleration, so nothing is subtracted and none of the smoothing is
    // given up where it is doing the work.
    //
    // Braking only. Compensating the same lag on the way up would be spending the smoothing exactly where
    // it was bought — the noise a fit makes on a hand picking up speed is the thing the ramp is for, and
    // trailing on the way up costs nothing worse than the lateness this whole library exists to remove.
    const rampLag = alongAcceleration < 0 ? alongAcceleration * horizon * rampMs : 0
    const distance = Math.max(0, travelled + rampLag)

    const swept = Math.max(-MAX_TURN_RAD, Math.min(MAX_TURN_RAD, turn * horizon))
    let along = distance
    let across = 0
    if (Math.abs(swept) > 1e-4) {
      along = (distance / swept) * Math.sin(swept)
      across = (distance / swept) * (1 - Math.cos(swept))
    }

    out.x = (along * tx + across * nx) * trust
    out.y = (along * ty + across * ny) * trust
    return true
  }

  /**
   * The lead actually handed out is an eased version of the lead the fit asks for. The raw figure steps
   * the moment motion starts, so both ends are eased and the correction is a change in speed rather than
   * a jump.
   *
   * The returned object is reused every call — read it, do not keep it.
   */
  const update = (input: PredictorUpdate): Lead => {
    const { nowMs, deltaMs } = input
    const leadFrames = input.leadFrames ?? defaultLeadFrames
    const decayMs = input.decayMs ?? defaultDecayMs
    const maxLeadPx = input.maxLeadPx ?? defaultMaxLeadPx

    // What this wants is the refresh interval, and a hitch is not a change of refresh interval. Feeding
    // one in raw moves the estimate by a fifth, which is two frames of horizon, which is pixels of lead
    // handed over on the frame after every stall. Clamping what the average is allowed to see leaves a
    // real refresh change to walk there over a few frames and a stall to barely register.
    if (deltaMs > 0) frameMs += (Math.min(deltaMs, frameMs * MAX_FRAME_STEP) - frameMs) * FRAME_SMOOTHING

    // What a count of this device is worth, settled a window at a time. A window that carried no motion has
    // nothing to say and is simply extended, so a hand sitting still cannot make the answer expire.
    if (countWindowAt < 0) countWindowAt = nowMs
    else if (nowMs - countWindowAt >= COUNT_WINDOW_MS && countThisWindow > 0) {
      gcdPx = countLastWindow > 0 ? Math.min(countThisWindow, countLastWindow) : QUANTISATION_PX
      countLastWindow = countThisWindow
      countThisWindow = 0
      countWindowAt = nowMs
    }

    // Whichever of the two readings says the grid is wider. A shared divisor is exact when the deltas have
    // one and says nothing at all when they do not, and the scatter is approximate but always available —
    // so they disagree in only one direction, and it is the direction where believing the smaller answer is
    // what puts every floor under the noise it is there to sit above.
    countPx = Math.min(MAX_COUNT_PX, Math.max(QUANTISATION_PX, gcdPx, grainPx))

    const newestT = count > 0 ? times[(head - 1 + CAPACITY) % CAPACITY]! : 0
    const hadInput = count > 0 && newestT > lastSeenNewest
    // Whether these samples landed on a window that was still standing, or on one the last stop had
    // already dropped. Read before it is overwritten, because that is the whole question.
    const resumedOntoWindow = lastSeenNewest > 0
    lastSeenNewest = newestT

    // Silence is the only evidence a hand has stopped, but how long a moving hand goes quiet is a property
    // of the device. A wired mouse reports every millisecond; one on a radio reports in bursts and can say
    // nothing for twenty. Reading any of that as a stop scaled the lead down on every frame that landed
    // between reports and back up on the next one — a four-fold flicker on a Bluetooth mouse, while the
    // hand moved perfectly steadily. So the quiet each device is known to keep is tolerated first, and
    // only what exceeds it counts as stopping.
    // What is being learned here is how long this device goes quiet *while the hand is still moving*, and
    // the silence that just ended is only evidence of that if the hand was in fact moving through it. Most
    // silences are not: they are the hand sitting still between one movement and the next, and taken at
    // face value they teach the predictor that this device reports three times a second. A quarter-second
    // pause before a flick was learned as a quarter-second of tolerated quiet, so the flick that followed
    // it stayed live long after the hand had stopped and the ramp went on climbing towards a window of
    // stale samples — the marker sailed on across the screen with the hand already still.
    //
    // The predictor has already answered that question about this silence, though, and the answer is
    // sitting right here: a silence it judged long enough to be a stop dropped the window and left nothing
    // behind it. So a gap that resumes onto a cleared window is one this device was never proven to have
    // been merely slow across, and there is nothing in it to learn. A device that genuinely reports in
    // bursts never gets that far — its gaps are shorter than the fade, which is what the tolerance is for.
    //
    // MAX_QUIET_MS sits under that as a plain backstop, since a gap can be far too long to be a report
    // interval while still being too short to have faded: no device reports that slowly while being moved.
    if (hadInput && resumedOntoWindow) {
      quietMs = Math.max(quietMs * QUIET_DECAY, Math.min(msSinceInput, MAX_QUIET_MS))
    } else if (hadInput) {
      quietMs *= QUIET_DECAY
    }
    msSinceInput = hadInput ? 0 : msSinceInput + deltaMs

    const tolerated = Math.max(quietMs * QUIET_TOLERANCE, frameMs)
    const freshness = Math.max(0, 1 - Math.max(0, msSinceInput - tolerated) / STOP_MS)
    if (freshness === 0) {
      clear()
      lastSeenNewest = 0
    }

    // What has to be covered is the time since the motion actually happened, not since the frame started:
    // a sample is already a good fraction of a frame old by the time the browser hands it over.
    // How late the browser hands the events over is roughly a property of the machine, but the figure read
    // on any one frame wanders by a few milliseconds. Left raw it goes straight into the horizon, and a few
    // milliseconds of horizon is pixels of lead on a hand that is doing nothing new — measured at four
    // pixels of jump per frame under ordinary frame timing, which is worse than any noise in the fit. The
    // average is the part worth compensating for, so the average is what is used.
    if (hadInput) {
      const age = Math.max(0, nowMs - newestT)
      smoothedAge += (age - smoothedAge) * (1 - Math.exp(-deltaMs / AGE_SMOOTHING_MS))
    }
    const elapsed = hadInput ? smoothedAge : msSinceInput
    const horizon = Math.min(elapsed, MAX_ELAPSED_MS) + leadFrames * frameMs

    // Both of these describe the guess this frame produced, so a frame that produces none must not be left
    // holding the last one's. A stale confidence keeps the ramp long through a stop that should fade at the
    // ordinary rate, and a stale turn keeps spinning the lead as it fades — a hand that stops mid-circle
    // leaves one behind, and it goes on turning after the hand has not.
    confidence = 1
    carriedTurn = 0

    out.x = 0
    out.y = 0
    // Unlike the two above, which the fit assigns outright, the brake is settled across frames — so it is
    // dropped only when there is no guess behind it at all, or a stale brake goes on shortening the ramp
    // through a fade that should run at the ordinary rate.
    if (!(count > 0 && freshness > 0 && fit(horizon, deltaMs, decayMs))) {
      brakeConfidence = 0
      lastSpeed = -1
      speedTrend = 0
    }

    let targetX = out.x * freshness
    let targetY = out.y * freshness

    const cap = Math.abs(maxLeadPx)
    const magnitude = Math.hypot(targetX, targetY)
    if (magnitude > cap && magnitude > 0) {
      targetX = (targetX / magnitude) * cap
      targetY = (targetY / magnitude) * cap
    }

    // The ramp is there to smooth how big the guess is, not which way it points. Easing in world axes
    // does both, so a turning hand drags its lead behind the heading by the ramp's own time constant —
    // 27 degrees on an ordinary circle, which lands the guess outside it. Carrying what is already there
    // around by the turn the path is believed to have leaves the ramp smoothing only the shape. A path
    // that is not turning rotates by nothing, so straight motion is untouched.
    if (carriedTurn !== 0) {
      const swept = Math.max(-MAX_TURN_RAD, Math.min(MAX_TURN_RAD, carriedTurn * deltaMs))
      const cos = Math.cos(swept)
      const sin = Math.sin(swept)
      const spunX = leadX * cos - leadY * sin
      leadY = leadX * sin + leadY * cos
      leadX = spunX
    }

    // A guess that is already fading may not also be growing. The window goes on saying the hand is moving
    // for as long as it holds the samples from before the stop, and the ramp is still climbing towards
    // that, so the lead went on rising for several frames after a flick ended — the marker sailing on with
    // the hand already still. Freshness was pulling the other way the whole time and simply lost: it scales
    // a target the ramp was nowhere near, so shrinking the target still left it above the lead.
    //
    // An empty frame on its own is not the gate: a device that leaves a third of frames empty while moving
    // perfectly steadily has to keep growing across them, or it holds back and then catches up in one step,
    // which is worse on screen than the lateness it saves. What counts is an empty frame on a device that
    // does not have empty frames, and that is exactly what the learned quiet says — a trackpad handing over
    // one coalesced sample every frame learns a quiet of nothing, so its first silent frame is already
    // unusual, while a mouse on a radio has to stay silent past its own burst gap before this fires.
    //
    // Freshness cannot be the gate because it is far too slow: it does not begin to fade until a whole
    // frame of silence has passed, and one frame is all it takes. Captured on a trackpad mid-flick, the
    // frame after the hand stopped carried no samples and no motion at all, and the lead still grew from 46
    // to 58px on it — a quarter of the guess invented on a frame that learned nothing, and the only frame
    // the eye gets to see it, because the next one is already being discounted.
    //
    // Holding costs a frame of the ramp, which is lateness and nothing worse. Growing on nothing is motion
    // on screen the hand never made, and a ratchet keeps it for the rest of the session.
    if (!hadInput && msSinceInput > quietMs * QUIET_TOLERANCE) {
      const held = Math.hypot(leadX, leadY)
      const wanted = Math.hypot(targetX, targetY)
      if (wanted > held) {
        const scale = held / wanted
        targetX *= scale
        targetY *= scale
      }
    }

    const rate = 1 - Math.exp(-deltaMs / rampLength(decayMs, confidence))
    leadX += (targetX - leadX) * rate
    leadY += (targetY - leadY) * rate
    if (Math.abs(leadX) < NEGLIGIBLE_PX) leadX = 0
    if (Math.abs(leadY) < NEGLIGIBLE_PX) leadY = 0

    out.x = leadX
    out.y = leadY
    out.live = freshness
    return out
  }

  /**
   * Drops the window and everything settled behind it. Call it whenever the pointer stops driving this
   * consumer — an unlocked pointer, a menu, a cutscene — or the next frame that resumes fits a curve
   * through motion from before the gap and applies the whole thing at once.
   */
  const reset = () => {
    clear()
    leadX = 0
    leadY = 0
    smoothedAge = 13
    msSinceInput = 0
    quietMs = 0
    lastSeenNewest = 0
    confidence = 1
    curveConfidence = 0
    brakeConfidence = 0
    lastSpeed = -1
    speedTrend = 0
    carriedTurn = 0
    headingTurn = 0
    headingX = 0
    headingY = 0
    msSinceReversal = 1e4
    reversalPeriodMs = 1e4
    turnRate = 0
    turnAverage = 0
    // What a count is worth is not part of the session. It is a property of the device, it does not change
    // across a menu, and dropping it would put the noise floors back to assuming pixels for the first half
    // second after every unlock — which is exactly when the hand is moving again.
  }

  return { push, pushFrame, update, reset }
}
