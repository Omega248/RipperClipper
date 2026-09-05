/**
 * What each editing application can actually be given, and how.
 *
 * Every row here was checked against that editor's current documentation, and
 * the ones that were not are marked as such rather than guessed. A capability
 * matrix that flatters itself is worse than no matrix: it produces a project
 * that imports cleanly and has quietly lost the watermark.
 */

export type EditorId =
  | 'resolve'
  | 'final-cut'
  | 'premiere'
  | 'avid'
  | 'vegas'
  | 'capcut'
  | 'movavi'
  | 'generic'

/** How well an editor does one thing. Ordered worst to best. */
export type Support = 'none' | 'manual' | 'partial' | 'full'

export const SUPPORT_MARK: Record<Support, string> = {
  none: '✗',
  manual: '⚠',
  partial: '△',
  full: '✓'
}

export const SUPPORT_LABEL: Record<Support, string> = {
  none: 'Unsupported',
  manual: 'Manual step',
  partial: 'Partly automatic',
  full: 'Automatic'
}

export interface EditorCapabilities {
  id: EditorId
  name: string
  /** How the project reaches the editor, in one phrase, for the UI to show. */
  mechanism: string
  mediaImport: Support
  timelineCreation: Support
  imageOverlay: Support
  transform: Support
  opacity: Support
  rotation: Support
  markers: Support
  metadata: Support
  relativePaths: Support
  projectGeneration: Support
  automaticLaunch: Support
  /** Platforms this editor exists on. */
  platforms: Array<'win32' | 'darwin' | 'linux'>
  /**
   * True when every row above was read off current documentation. False means
   * the adapter is not written yet and the row is a placeholder the UI must
   * not present as fact.
   */
  verified: boolean
  /** What the editor cannot do, in the words the user should read. */
  limitations: string[]
}

export const EDITORS: Record<EditorId, EditorCapabilities> = {
  resolve: {
    id: 'resolve',
    name: 'DaVinci Resolve',
    mechanism: 'Generated Python script, run from Resolve’s own Scripts menu',
    mediaImport: 'full',
    timelineCreation: 'full',
    imageOverlay: 'full',
    transform: 'full',
    opacity: 'full',
    rotation: 'full',
    markers: 'full',
    metadata: 'partial',
    relativePaths: 'none',
    projectGeneration: 'full',
    automaticLaunch: 'partial',
    platforms: ['win32', 'darwin', 'linux'],
    verified: true,
    limitations: [
      'Resolve’s API takes absolute paths, so the project is written with them. Moving the folder afterwards means relinking in Resolve.',
      'The script has to be run from inside Resolve — Workspace → Scripts. Nothing is executed on your machine by this app.'
    ]
  },
  'final-cut': {
    id: 'final-cut',
    name: 'Final Cut Pro',
    mechanism: 'FCPXML, Apple’s documented interchange format',
    mediaImport: 'full',
    timelineCreation: 'full',
    imageOverlay: 'full',
    transform: 'full',
    opacity: 'full',
    rotation: 'full',
    markers: 'full',
    metadata: 'partial',
    relativePaths: 'partial',
    projectGeneration: 'full',
    automaticLaunch: 'partial',
    platforms: ['darwin'],
    verified: true,
    limitations: [
      'FCPXML describes a project for import; it is not a native Final Cut library, and Apple says so explicitly.',
      'Final Cut is macOS only.'
    ]
  },
  premiere: {
    id: 'premiere',
    name: 'Adobe Premiere Pro',
    mechanism: 'Not implemented yet — capabilities unverified',
    mediaImport: 'partial',
    timelineCreation: 'partial',
    imageOverlay: 'manual',
    transform: 'manual',
    opacity: 'manual',
    rotation: 'manual',
    markers: 'partial',
    metadata: 'partial',
    relativePaths: 'partial',
    projectGeneration: 'none',
    automaticLaunch: 'none',
    platforms: ['win32', 'darwin'],
    verified: false,
    limitations: [
      'No adapter yet. Use the portable export and import the media by hand, or use Resolve.'
    ]
  },
  avid: {
    id: 'avid',
    name: 'Avid Media Composer',
    mechanism: 'Not implemented yet — capabilities unverified',
    mediaImport: 'partial',
    timelineCreation: 'partial',
    imageOverlay: 'manual',
    transform: 'manual',
    opacity: 'manual',
    rotation: 'manual',
    markers: 'partial',
    metadata: 'partial',
    relativePaths: 'none',
    projectGeneration: 'none',
    automaticLaunch: 'none',
    platforms: ['win32', 'darwin'],
    verified: false,
    limitations: ['No adapter yet. Use the portable export.']
  },
  vegas: {
    id: 'vegas',
    name: 'VEGAS Pro',
    mechanism: 'Not implemented yet — capabilities unverified',
    mediaImport: 'partial',
    timelineCreation: 'manual',
    imageOverlay: 'manual',
    transform: 'manual',
    opacity: 'manual',
    rotation: 'manual',
    markers: 'manual',
    metadata: 'partial',
    relativePaths: 'partial',
    projectGeneration: 'none',
    automaticLaunch: 'none',
    platforms: ['win32'],
    verified: false,
    limitations: ['No adapter yet. Use the portable export.']
  },
  capcut: {
    id: 'capcut',
    name: 'CapCut',
    mechanism: 'Portable folder and a setup guide — CapCut has no documented project format',
    mediaImport: 'manual',
    timelineCreation: 'manual',
    imageOverlay: 'manual',
    transform: 'manual',
    opacity: 'manual',
    rotation: 'manual',
    markers: 'none',
    metadata: 'partial',
    relativePaths: 'partial',
    projectGeneration: 'none',
    automaticLaunch: 'none',
    platforms: ['win32', 'darwin'],
    verified: true,
    limitations: [
      'CapCut publishes no project format, so nothing can be generated for it honestly. You get the media, the watermark image, and a guide with the exact numbers to type in.',
      'The angles are still cut and synchronised — that part is done for you.'
    ]
  },
  movavi: {
    id: 'movavi',
    name: 'Movavi Video Editor',
    mechanism: 'Portable folder and a setup guide — Movavi publishes no project format',
    mediaImport: 'manual',
    timelineCreation: 'manual',
    imageOverlay: 'manual',
    transform: 'manual',
    opacity: 'manual',
    rotation: 'manual',
    markers: 'none',
    metadata: 'partial',
    relativePaths: 'partial',
    // Not 'none': there is no project *file*, but the export does the work a
    // project file would have saved — see the second limitation.
    projectGeneration: 'partial',
    automaticLaunch: 'none',
    platforms: ['win32', 'darwin'],
    verified: true,
    limitations: [
      'Movavi’s project file (.mepx) is proprietary and undocumented, and the editor imports no interchange format — no XML, no AAF, no EDL. Nothing can be generated for it honestly: a .mepx written by guesswork either refuses to open or opens having silently dropped angles.',
      'The alignment is done for you anyway. Every angle is cut from the same instant, so you drop them all at the start of the timeline and they are already in sync — no nudging. Only an angle that started recording after the moment began needs moving, and movavi-timeline.csv says exactly how far.'
    ]
  },
  generic: {
    id: 'generic',
    name: 'Any editor (portable folder)',
    mechanism: 'Media, assets, a JSON manifest and an HTML guide',
    mediaImport: 'manual',
    timelineCreation: 'manual',
    imageOverlay: 'manual',
    transform: 'manual',
    opacity: 'manual',
    rotation: 'manual',
    markers: 'none',
    metadata: 'full',
    relativePaths: 'full',
    projectGeneration: 'partial',
    automaticLaunch: 'none',
    platforms: ['win32', 'darwin', 'linux'],
    verified: true,
    limitations: [
      'Nothing is generated for a specific editor, so the timeline is built by hand — but every number you need is in the guide, including each angle’s sync offset.'
    ]
  }
}

/** The editors offered, best-supported first. */
export const EDITOR_ORDER: EditorId[] = [
  'resolve',
  'final-cut',
  'generic',
  'capcut',
  'movavi',
  'premiere',
  'avid',
  'vegas'
]

/** Editors with a real adapter behind them. */
export function implementedEditors(): EditorCapabilities[] {
  return EDITOR_ORDER.map((id) => EDITORS[id]).filter((e) => e.projectGeneration !== 'none')
}
