import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_EXPORT_SETTINGS, defaultSettings, mergeSettings } from '../../shared/defaults.js'
import type { AppSettings } from '../../shared/types.js'
import type { Logger } from './logger.js'

/** Persisted application settings with atomic writes. */
export class SettingsStore {
  private settings: AppSettings
  private readonly file: string

  constructor(
    private readonly log: Logger,
    configDir: string,
    paths: { outputDirectory: string; cacheDirectory: string }
  ) {
    this.file = join(configDir, 'settings.json')
    this.settings = defaultSettings(paths)
  }

  get current(): AppSettings {
    return this.settings
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.file, 'utf8')
      this.settings = mergeSettings(this.settings, JSON.parse(raw))
      // Installs made before exports carried the streamer and date keep the
      // bare "{Name}". Anything the editor actually chose is left alone.
      if (this.settings.export.filenameTemplate === '{Name}') {
        this.settings.export.filenameTemplate = DEFAULT_EXPORT_SETTINGS.filenameTemplate
        this.log.info('settings', 'Filename template updated to include streamer and date')
        await this.save()
      }
      this.log.info('settings', 'Settings loaded', { file: this.file })
    } catch {
      this.log.info('settings', 'Using default settings', { file: this.file })
      await this.save()
    }
    this.log.setLevel(this.settings.advanced.logLevel)
    return this.settings
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = mergeSettings(this.settings, { ...this.settings, ...patch })
    this.log.setLevel(this.settings.advanced.logLevel)
    await this.save()
    return this.settings
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.settings, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}
