/**
 * Where this machine keeps DSH, resolved instead of hardcoded.
 *
 * Every diagnostic in this directory needs one of two things the package cannot
 * know on its own: the DSH home directory (where sessions and the profile live) and
 * the installed DSH itself (whose modules the native-opener probes call directly).
 * Both used to be absolute paths with one developer's name in them, which made
 * these scripts useless on any other machine and put that name in a public repo.
 *
 * Resolution order, each overridable so a test rig can point somewhere else:
 *
 *   * `$DSH_HOME`, else `~/.dsh`
 *   * `$DSH_INSTALL`, else `$(npm root -g)/@deepseek-ai/dsh`
 *
 * @module test/dsh-paths
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** DSH's own directory: sessions, profiles, storages, settings. */
export const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Where session logs live, one directory per project. */
export const sessionsRoot = join(dshHome, 'sessions')

/** The `node_modules` of the profile this project is developed against. */
export const profileModules = join(dshHome, 'profiles', process.env.DSH_PROFILE ?? 'web', 'node_modules')

let cached

/**
 * The global install directory, asked two ways.
 *
 * `npm root -g` is the documented answer but cannot be exec'd directly on Windows:
 * `npm` there is a `.cmd` shim, which `execFileSync` refuses without a shell. So the
 * CLI's own location on `PATH` is tried first — `where dsh` / `which dsh` — because
 * the global `node_modules` always sits beside it.
 *
 * @returns a candidate package directory, or undefined.
 */
function fromPathOrNpm() {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const found = execFileSync(finder, ['dsh'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
    if (found.length > 0) return join(dirname(found[0]), 'node_modules', '@deepseek-ai', 'dsh')
  } catch {
    // Not on PATH: npm may still know.
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, shell: true }).trim()
    if (root !== '') return join(root, '@deepseek-ai', 'dsh')
  } catch {
    return undefined
  }
  return undefined
}

/**
 * The installed `@deepseek-ai/dsh` package directory.
 *
 * Resolution order: `$DSH_INSTALL`, then wherever the `dsh` command on `PATH` lives,
 * then `npm root -g`. Each is checked for the package layout, so a wrong guess
 * degrades to the next rather than to a confusing import failure.
 *
 * @returns the directory containing `lib/bin.js`.
 * @throws when none of them points at a DSH install.
 */
export function dshInstall() {
  if (cached !== undefined) return cached
  const candidates = []
  if (process.env.DSH_INSTALL !== undefined && process.env.DSH_INSTALL !== '') candidates.push(process.env.DSH_INSTALL)
  const discovered = fromPathOrNpm()
  if (discovered !== undefined) candidates.push(discovered)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules', '@deepseek-ai'))) {
      cached = candidate
      return cached
    }
  }
  throw new Error('test/dsh-paths: cannot find the installed @deepseek-ai/dsh; set DSH_INSTALL to its directory')
}

/**
 * One module inside a package the installed DSH carries, as an import URL.
 *
 * The probes call Host code directly — `dsh-native-command`'s path openers — and
 * that package lives under DSH's own `node_modules`, not this project's.
 *
 * @param pkg - package name, e.g. `dsh-native-command`.
 * @param entry - path inside the package, e.g. `lib/index.js`.
 * @returns a `file://` URL a dynamic `import()` accepts.
 */
export function dshModuleUrl(pkg, entry) {
  return pathToFileURL(join(dshInstall(), 'node_modules', '@deepseek-ai', pkg, entry)).href
}

/**
 * Every built frontend asset that can carry CSS or CSS-module class names.
 *
 * The class *names* live in the entry JS (`_menuItem_<hash>`) and the *rules* live
 * in a stylesheet beside it, so a reader that wants the rules has to look in both.
 * File names carry content hashes, which is why they are found rather than named.
 *
 * @returns absolute paths, stylesheets first.
 */
export function frontendAssets() {
  const assets = join(dshInstall(), 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
  if (!existsSync(assets)) throw new Error(`test/dsh-paths: no built frontend at ${assets}`)
  const names = readdirSync(assets)
  const css = names.filter((name) => name.endsWith('.css')).map((name) => join(assets, name))
  const js = names.filter((name) => /^index-.*\.js$/.test(name)).map((name) => join(assets, name))
  if (css.length === 0 && js.length === 0) throw new Error(`test/dsh-paths: no assets under ${assets}`)
  return [...css, ...js]
}

/**
 * The built web frontend's entry bundle.
 *
 * @returns the `dist/assets/index-*.js` path.
 * @throws when the frontend package or its bundle is missing.
 */
export function frontendBundle() {
  const found = frontendAssets().filter((path) => path.endsWith('.js'))
  if (found.length === 0) throw new Error('test/dsh-paths: no index-*.js in the built frontend')
  return found[found.length - 1]
}
