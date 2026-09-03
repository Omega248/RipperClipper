/**
 * Kept as a re-export: the rule itself moved to `shared/playbackSrc.ts`.
 *
 * It has to be reachable from a main-process test, because the thing worth
 * asserting is that the URL this builds is one the proxy will actually serve —
 * and those two halves drifting apart is exactly what turned every POV black
 * once already.
 */
export { playbackSrc } from '@shared/playbackSrc'
