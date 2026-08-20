import { useEffect, useState } from 'react'
import type { ProjectBackupInfo } from '@shared/ipc'
import type { ProjectFile } from '@shared/types'
import { Button, Dialog, EmptyState, Spinner } from '../ui/index.js'
import { message, title } from './QualityPanel.js'
import { useStore } from '../store.js'

interface Props {
  /** Path the project is currently saved to — backups live alongside it. */
  projectPath: string
  onClose: () => void
  onRestored: (project: ProjectFile) => void
}

/**
 * Every explicit save snapshots whatever was on disk beforehand (see
 * ProjectStore.save), so a mistake that already got saved over is still
 * recoverable here — unlike the single autosave slot, this keeps a bounded
 * history of prior versions.
 */
export default function VersionHistoryDialog({ projectPath, onClose, onRestored }: Props): JSX.Element {
  const toast = useStore((s) => s.toast)
  const [backups, setBackups] = useState<ProjectBackupInfo[] | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.listBackups(projectPath).then((list) => {
      if (!cancelled) setBackups(list)
    })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const restore = async (backup: ProjectBackupInfo): Promise<void> => {
    setRestoring(backup.path)
    try {
      const project = await window.api.restoreBackup(backup.path)
      onRestored(project)
      toast({
        kind: 'success',
        title: 'Version restored',
        message: 'Save the project to keep this version — it replaces the current one only once you save.'
      })
      onClose()
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Restore failed'), message: message(err) })
    } finally {
      setRestoring(null)
    }
  }

  return (
    <Dialog
      title="Version history"
      description="A snapshot is kept each time you save over this project, oldest ones dropped past 10."
      size="medium"
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {backups === null ? (
        <Spinner />
      ) : backups.length === 0 ? (
        <EmptyState
          icon="refresh"
          title="No prior versions yet"
          description="Save over this project at least twice to start building a history."
        />
      ) : (
        <ul className="version-history-list">
          {backups.map((backup) => (
            <li key={backup.path} className="version-history-row">
              <span>{new Date(backup.savedAt).toLocaleString()}</span>
              <Button
                size="compact"
                disabled={restoring !== null}
                onClick={() => void restore(backup)}
              >
                {restoring === backup.path ? 'Restoring…' : 'Restore'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
