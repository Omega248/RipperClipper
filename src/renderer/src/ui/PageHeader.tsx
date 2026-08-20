import type { ReactNode } from 'react'

/**
 * Every page opens the same way: what this page is, one line about what it is
 * for, and the page's primary action on the right. The structure does not vary
 * between pages — only the words do — so moving between Audio, Export and
 * Properties never costs the editor a re-orientation.
 */
export default function PageHeader({
  title,
  description,
  actions,
  meta
}: {
  title: string
  description?: string
  /** The page's actions. The primary one goes last. */
  actions?: ReactNode
  /** Small facts about what is being shown — counts, ranges. */
  meta?: ReactNode
}): JSX.Element {
  return (
    <header className="ui-page-header">
      <div className="ui-page-heading">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        {meta && <div className="ui-page-meta">{meta}</div>}
      </div>
      {actions && <div className="ui-page-actions">{actions}</div>}
    </header>
  )
}

/** A titled block within a page or a dialog. */
export function Section({
  title,
  description,
  actions,
  children
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="ui-section">
      <div className="ui-section-head">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="ui-section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}
