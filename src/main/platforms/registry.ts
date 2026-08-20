import { Errors } from '../../shared/errors.js'
import { KickAdapter } from './kick.js'
import { TwitchAdapter } from './twitch.js'
import { YouTubeAdapter } from './youtube.js'
import { safeUrl } from './types.js'
import type { PlatformAdapter, UrlMatch } from './types.js'

export class AdapterRegistry {
  private readonly adapters: PlatformAdapter[]

  constructor(adapters?: PlatformAdapter[]) {
    this.adapters = adapters ?? [new TwitchAdapter(), new KickAdapter(), new YouTubeAdapter()]
  }

  all(): PlatformAdapter[] {
    return this.adapters
  }

  /** Find the adapter for a URL. Throws a specific error when nothing matches. */
  detect(url: string): { adapter: PlatformAdapter; match: UrlMatch } {
    if (safeUrl(url) === null) throw Errors.invalidUrl(url)
    for (const adapter of this.adapters) {
      const match = adapter.match(url)
      if (match) return { adapter, match }
    }
    throw Errors.unsupportedUrl(url)
  }

  tryDetect(url: string): { adapter: PlatformAdapter; match: UrlMatch } | null {
    try {
      return this.detect(url)
    } catch {
      return null
    }
  }

  byId(id: string): PlatformAdapter | null {
    return this.adapters.find((a) => a.id === id) ?? null
  }
}
