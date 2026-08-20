/**
 * Packaging config for all three distributables built from this repo.
 *
 * `RIPPER_CHANNEL` (same variable electron.vite.config.ts reads) picks
 * which one — `stable` (default, unset), `experimental`, or `dev`. Each gets
 * its own app identity (id, name, install directory, Start Menu entry) so
 * all three can be installed side by side without overwriting one another.
 * A plain `npm run package:win` never sets it, so the production bundle
 * never had the Editor's code in it in the first place (see
 * electron.vite.config.ts) — this file only decides how each is labelled
 * and installed.
 */
const channel =
  process.env.RIPPER_CHANNEL === 'experimental'
    ? 'experimental'
    : process.env.RIPPER_CHANNEL === 'dev' || process.env.RIPPER_EDITOR === '1'
      ? 'dev'
      : 'stable'

const IDENTITY = {
  stable: { appId: 'com.ripperclipper.app', productName: 'Ripper Clipper' },
  experimental: { appId: 'com.ripperclipper.experimental', productName: 'Ripper Clipper Experimental' },
  dev: { appId: 'com.ripperclipper.dev', productName: 'Ripper Clipper Dev' }
}[channel]

export default {
  appId: IDENTITY.appId,
  productName: IDENTITY.productName,
  copyright: 'Ripper Clipper',

  directories: {
    output: channel === 'stable' ? 'release' : `release-${channel}`,
    buildResources: 'build'
  },

  icon: 'build/icon.png',

  files: ['out/**', 'package.json'],

  extraResources: [
    {
      from: 'resources/bin',
      to: 'bin',
      filter: ['**/*', '!README.md']
    },
    {
      from: 'resources/icon.png',
      to: 'icon.png'
    }
  ],

  asar: true,

  fileAssociations: [
    {
      ext: 'cookieclip',
      name: 'Ripper Clipper project',
      description: 'Ripper Clipper project',
      role: 'Editor'
    }
  ],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: '${productName}-${version}-setup.${ext}',
    // No certificate is configured (the build is unsigned), so this step
    // would only try to stamp version metadata onto the .exe — but doing
    // that at all makes electron-builder fetch its winCodeSign tool bundle,
    // which contains macOS-side symlinked files that fail to extract on any
    // Windows account without Developer Mode or an elevated shell (the
    // extraction needs SeCreateSymbolicLinkPrivilege). Skipping this avoids
    // that dependency entirely; nothing here needs it since there's no
    // certificate to apply in the first place.
    signAndEditExecutable: false
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: IDENTITY.productName
  },

  linux: {
    target: ['AppImage'],
    category: 'AudioVideo'
  },

  mac: {
    target: ['dmg'],
    category: 'public.app-category.video'
  }
}
