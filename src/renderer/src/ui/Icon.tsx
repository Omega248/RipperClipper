/**
 * The icon set.
 *
 * One family, one grid, one weight: every glyph is drawn on a 24-unit box with
 * a 2-unit round-joined stroke and rendered at 16px by default, so nothing in
 * the interface is ever a different thickness from the control beside it. They
 * are paths rather than a font or a dependency, which keeps them tintable by
 * `currentColor` and keeps the package list unchanged.
 *
 * Icons never replace a label on a destructive or unusual action; where one is
 * used alone, `IconButton` requires a label and renders a tooltip from it.
 */

export type IconName =
  | 'play'
  | 'pause'
  | 'stop'
  | 'skip-back'
  | 'skip-forward'
  | 'rewind'
  | 'forward'
  | 'volume'
  | 'volume-off'
  | 'fullscreen'
  | 'mark-in'
  | 'mark-out'
  | 'loop'
  | 'plus'
  | 'minus'
  | 'close'
  | 'check'
  | 'alert'
  | 'info'
  | 'chevron-down'
  | 'chevron-up'
  | 'chevron-left'
  | 'chevron-right'
  | 'undo'
  | 'redo'
  | 'download'
  | 'copy'
  | 'trash'
  | 'search'
  | 'filter'
  | 'settings'
  | 'grid'
  | 'folder'
  | 'file'
  | 'refresh'
  | 'users'
  | 'music'
  | 'speech'
  | 'waveform'
  | 'target'
  | 'scissors'
  | 'grip'
  | 'external'
  | 'help'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'more'
  | 'sort'
  | 'clock'
  | 'save'
  | 'open'
  | 'new'
  | 'flag'
  | 'link'
  | 'edit'
  | 'spinner'
  | 'window-minimize'
  | 'window-maximize'
  | 'window-restore'
  | 'shield'
  | 'car'
  | 'medical'
  | 'skull'
  | 'crown'
  | 'flame'
  | 'star'
  | 'briefcase'
  | 'list'

/** Path data only — every icon inherits the same stroke settings below. */
const PATHS: Record<IconName, string> = {
  play: 'M7 4.5v15l13-7.5z',
  pause: 'M8 5v14M16 5v14',
  stop: 'M6 6h12v12H6z',
  'skip-back': 'M18 5v14L7 12zM5 5v14',
  'skip-forward': 'M6 5v14l11-7zM19 5v14',
  rewind: 'M11 5v14L2 12zM22 5v14l-9-7z',
  forward: 'M2 5v14l9-7zM13 5v14l9-7z',
  volume: 'M4 9v6h4l5 4V5L8 9zM17 9.5a3.5 3.5 0 0 1 0 5M19.5 7a7 7 0 0 1 0 10',
  'volume-off': 'M4 9v6h4l5 4V5L8 9zM17 10l5 4M22 10l-5 4',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  'mark-in': 'M6 4v16M6 4h6l-2 4 2 4H6',
  'mark-out': 'M18 4v16M18 4h-6l2 4-2 4h6',
  loop: 'M4 9a5 5 0 0 1 5-5h9M18 4l-3-3M18 4l-3 3M20 15a5 5 0 0 1-5 5H6M6 20l3 3M6 20l3-3',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M4 12.5l5 5L20 6.5',
  alert: 'M12 4l9 16H3zM12 10v4M12 17.5v.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8v.5',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M6 15l6-6 6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  undo: 'M4 10h9a5 5 0 0 1 0 10H8M4 10l4-4M4 10l4 4',
  redo: 'M20 10h-9a5 5 0 0 0 0 10h5M20 10l-4-4M20 10l-4 4',
  download: 'M12 4v11M7 11l5 5 5-5M4 20h16',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM17 17l4 4',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 3 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5',
  users: 'M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-2a4 4 0 0 0-3-3.9M16 3.6a4 4 0 0 1 0 7.7',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  speech: 'M12 3a4 4 0 0 1 4 4v4a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4zM5 11a7 7 0 0 0 14 0M12 18v3',
  waveform: 'M3 12h2M7 7v10M11 4v16M15 8v8M19 11h2',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v3M12 19v3M2 12h3M19 12h3',
  scissors: 'M7 7l10 10M17 7L7 17M7.5 7.5a2.5 2.5 0 1 1-3.5-3.5 2.5 2.5 0 0 1 3.5 3.5zM7.5 16.5a2.5 2.5 0 1 0-3.5 3.5 2.5 2.5 0 0 0 3.5-3.5z',
  grip: 'M9 6h.5M9 12h.5M9 18h.5M15 6h.5M15 12h.5M15 18h.5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5A2.5 2.5 0 1 1 12 13v1.5M12 17.5v.5',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  monitor: 'M3 5h18v11H3zM9 20h6M12 16v4',
  more: 'M6 12h.5M12 12h.5M18 12h.5',
  sort: 'M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  save: 'M5 4h11l3 3v13H5zM8 4v6h8V4M8 20v-6h8v6',
  open: 'M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2H3zM3 10h18l-2 9H5z',
  new: 'M6 3h8l5 5v13H6zM14 3v5h5M12 11v6M9 14h6',
  flag: 'M5 21V4h13l-3 4 3 4H5',
  link: 'M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.5 6M14 11a4 4 0 0 0-5.7 0l-3 3A4 4 0 1 0 11 19.7l1.5-1.5',
  edit: 'M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3zM14 6l4 4',
  spinner: 'M12 3a9 9 0 0 1 9 9',
  'window-minimize': 'M5 12h14',
  'window-maximize': 'M5 5h14v14H5z',
  'window-restore': 'M8 8V5h11v11h-3M5 8h11v11H5z',
  shield: 'M12 3l7 3v5c0 5.5-3.5 8.5-7 10-3.5-1.5-7-4.5-7-10V6l7-3z',
  car: 'M4 16l1.3-5.2A2 2 0 0 1 7.2 9.3h9.6a2 2 0 0 1 1.9 1.5L20 16M3 16h18M7 16v2.5M17 16v2.5',
  medical: 'M10 3h4v5h5v4h-5v9h-4v-9H5V8h5V3z',
  skull:
    'M12 4a6 6 0 0 0-6 6v3l1.5 1.5V17h2v-1.5h1V17h3v-1.5h1V17h2v-2.5L18 13v-3a6 6 0 0 0-6-6zM9.5 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM14.5 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  crown: 'M4 19h16l1-10-5.5 3.5L12 6l-3.5 6.5L3 9l1 10z',
  flame:
    'M12 3c.5 3-2.5 4-3 6.5a3.5 3.5 0 0 0 7 0c0-1-.5-2-.5-2 1.5 1 2.5 3 2.5 5a5.5 5.5 0 1 1-11 0C7 8 12 6 12 3z',
  star: 'M12 3l2.5 5.6L21 9.3l-4.6 4.3 1.2 6.4L12 16.9l-5.6 3.1 1.2-6.4L3 9.3l6.5-.7L12 3z',
  briefcase: 'M4 8h16v11H4V8zM9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M4 13h16',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'
}

interface Props {
  name: IconName
  /** Pixel size; the stroke scales with it so weight stays even. */
  size?: number
  className?: string
}

export default function Icon({ name, size = 16, className }: Props): JSX.Element {
  return (
    <svg
      className={`icon${name === 'spinner' ? ' icon-spin' : ''}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={name === 'play' || name === 'skip-back' || name === 'skip-forward' ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
