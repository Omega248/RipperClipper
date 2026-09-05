import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { useStore } from './store.js'
import { rescueProject } from '@shared/rescue'

/**
 * What the user sees when the UI throws.
 *
 * Without this, one exception anywhere in the tree unmounts the whole thing
 * and leaves a blank window: no menu, no Ctrl+S, and — because autosave is a
 * timer living inside that tree — no more autosaves either. Every clip cut
 * since the last tick would be gone, with the only way out being to kill the
 * process. That is the worst outcome this app has, and it is reachable from a
 * single bad render.
 *
 * So the first thing this does is *save*, before it draws anything. The
 * project lives in a Zustand store outside React, so it survives the unmount
 * and can still be written to disk even though the tree that was showing it is
 * gone.
 */

interface State {
  error: Error | null
  saved: 'saving' | 'saved' | 'failed' | 'nothing' | null
  savedPath: string | null
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, saved: null, savedPath: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the only thing that says *where*, and it exists
    // nowhere else — the main process never sees this throw.
    void window.api
      .logEvent('error', 'crash', `The UI threw: ${error.message}`, {
        stack: error.stack ?? null,
        componentStack: info.componentStack ?? null
      })
      .catch(() => undefined)
    void this.rescue()
  }

  /** Get the work on disk before anything else, including before rendering. */
  private async rescue(): Promise<void> {
    const { project, projectPath } = useStore.getState()
    this.setState({ saved: 'saving' })
    const outcome = await rescueProject(window.api, project ?? null, projectPath ?? null)
    this.setState({
      saved: outcome.kind === 'saved' ? 'saved' : outcome.kind,
      savedPath: outcome.kind === 'saved' ? outcome.path : null
    })
  }

  override render(): ReactNode {
    const { error, saved, savedPath } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash" role="alert">
        <div className="crash-panel">
          <h1>Ripper Clipper hit a problem on this screen</h1>
          <p>
            The rest of the app is still running. Nothing has been downloaded, exported or deleted
            because of this.
          </p>

          <p className="crash-save">
            {saved === 'saving' && 'Saving your project…'}
            {saved === 'saved' && (
              <>Your project was saved{savedPath ? <> to {savedPath}</> : null}.</>
            )}
            {saved === 'failed' && 'Your project could not be saved automatically — the recovery copy from the last autosave is still on disk, and Reload offers it.'}
            {saved === 'nothing' && 'No project was open, so there was nothing to save.'}
          </p>

          <div className="crash-actions">
            <button type="button" onClick={() => window.location.reload()}>
              Reload the app
            </button>
            <button
              type="button"
              onClick={() => void window.api.logsPath().then((path) => window.api.openPath(path))}
            >
              Open the log
            </button>
          </div>

          <details className="crash-details">
            <summary>Technical details</summary>
            <pre>{error.stack ?? error.message}</pre>
          </details>
        </div>
      </div>
    )
  }
}
