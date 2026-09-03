/**
 * What to call a project before the editor has said.
 *
 * "Untitled project" was the answer for both paths that create one, which is
 * fine exactly once — the second and third of them are indistinguishable in a
 * recent-projects list, and the folder of exports they write is named after
 * them. Neither suggestion here is binding: one prefills a dialog, the other
 * names a project the app created implicitly and can be renamed any time.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A fixed `d MMM yyyy`, deliberately not `toLocaleDateString`: this ends up in
 * a project name and then in an export folder name, and a name that renders
 * differently depending on the machine's locale is a name you cannot search
 * for. Returns null for a date that is not one.
 */
export function shortDate(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  const time = date.getTime()
  if (!Number.isFinite(time)) return null
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

/** The prefilled name in the new-project dialog. */
export function suggestedProjectName(now: Date = new Date()): string {
  return shortDate(now) ?? 'New project'
}

/**
 * A name for a project the app created on the editor's behalf, taken from the
 * first VOD going into it — which is the only thing anybody knows about it at
 * that point, and a far better label than "Untitled project" for the event
 * that is about to be built around it.
 *
 * The creator leads because a project is one event and its angles are people;
 * the broadcast date disambiguates the same streamer's Tuesday from their
 * Wednesday. Falls back through what is actually known rather than inventing.
 */
export function projectNameFromSource(source: {
  creator?: string | null
  title?: string | null
  createdAt?: string | null
}): string {
  const who = source.creator?.trim()
  const when = shortDate(source.createdAt)
  if (who && when) return `${who} — ${when}`
  if (who) return who
  const title = source.title?.trim()
  if (title) return title.length > 60 ? `${title.slice(0, 57).trimEnd()}…` : title
  return suggestedProjectName()
}
