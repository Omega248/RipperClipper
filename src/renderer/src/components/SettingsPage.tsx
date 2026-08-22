import { SettingsBody } from './SettingsDialog.js'
import { PageHeader } from '../ui/index.js'

/**
 * Settings as a destination.
 *
 * The same controls as the dialog, from the same component — reaching them
 * from the rail should not mean a second, slowly-diverging copy. The dialog
 * stays, because settings are often wanted without abandoning what you were
 * in the middle of.
 */
export default function SettingsPage(): JSX.Element {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Appearance, export defaults, storage, tools and shortcuts."
      />
      <SettingsBody />
    </>
  )
}
