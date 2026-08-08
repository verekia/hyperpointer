// Public entry point.
//
// Four pieces, each usable on its own:
//
//   createPointerBuffer    collect move events per event, drain them per frame
//   createPointerPredictor guess where the pointer will be when the frame reaches the screen
//   createLeadRatchet      apply that guess to something with no true position to correct against
//   createStickReader      the buffer's job, for a virtual joystick that reports a position
//
// Nothing here imports anything, touches the DOM at module scope, or holds module state, so it is safe to
// import on a server and safe to have several independent consumers in one page.

export {
  createPointerPredictor,
  DEFAULT_DECAY_MS,
  DEFAULT_LEAD_FRAMES,
  DEFAULT_MAX_LEAD_PX,
  type Lead,
  type PointerPredictor,
  type PredictorOptions,
  type PredictorUpdate,
} from './predictor.js'

export {
  createPointerBuffer,
  type PointerBuffer,
  type PointerBufferOptions,
  type PointerFrame,
  type PointerMoveLike,
} from './pointer.js'

export { createLeadRatchet, type LeadRatchet } from './ratchet.js'

export { createStickReader, type StickReader, type StickReading } from './stick.js'

export type { Vector2 } from './types.js'
