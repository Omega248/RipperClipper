/**
 * Packaging config for both distributables built from this repo.
 *
 * `RIPPER_EDITOR=1` (set by `npm run package:win:dev`) produces "Ripper
 * Clipper Dev" — a separate app identity (id, name, install directory,
 * Start Menu entry) so it installs side by side with the production app
 * instead of overwriting it. A plain `npm run package:win` builds the
 * production app; its bundle never had the Editor's code in it in the first
 * place (see electron.vite.config.ts), this file only decides how it's
 * labelled and installed.
 */
const isDev = process.env.RIPPER_EDITOR === '1'

export default {
  appId: isDev ? 'com.ripperclipper.dev' : 'com.ripperclipper.app',
  productName: isDev ? 'Ripper Clipper Dev' : 'Ripper Clipper',
  copyright: 'Ripper Clipper',

  directories: {
    output: isDev ? 'release-dev' : 'release',
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
    artifactName: '${productName}-${version}-setup.${ext}'
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: isDev ? 'Ripper Clipper Dev' : 'Ripper Clipper'
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
