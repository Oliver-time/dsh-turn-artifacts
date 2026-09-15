/**
 * Reads the dockkit tab-menu CSS out of the shipped frontend bundle.
 *
 * The menu renders its own "close tab" button with the CSS-module class
 * `_menuItem_<hash>` and appends this plugin's items next to it untouched, so the
 * plugin has to match that style by hand. This prints the rules to copy.
 *
 * Run with: node test/menu-css.mjs
 *
 * @module test/menu-css
 */

import { readFileSync } from 'node:fs'
import { frontendAssets } from './dsh-paths.mjs'

const assets = frontendAssets()
const bundle = assets.filter((path) => path.endsWith('.js')).pop()
console.log(`assets: ${String(assets.length)} files`)
console.log(`bundle: ${bundle}`)

// The class *names* are in the entry JS and the *rules* are in the stylesheet, so
// each is searched where it actually lives.
const js = readFileSync(bundle, 'utf8')
const css = assets.filter((path) => path.endsWith('.css')).map((path) => readFileSync(path, 'utf8')).join('\n')

const rule = (selector) => {
  // The hash suffix (`_menuItem_17p4l_460`) is the line number the class was
  // declared on, and pseudo-classes follow it, so both are matched loosely.
  const pattern = new RegExp(`\\.${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\w-]*(?:[:.][^{,]*)?\\{[^}]*\\}`, 'g')
  return css.match(pattern) ?? []
}

const menuItem = /_menuItem_[A-Za-z0-9]+/.exec(js)?.[0]
const menu = /[^-]_menu_[A-Za-z0-9]+/.exec(js)?.[0]?.slice(1)
console.log(`menuItem class: ${String(menuItem)}`)
console.log(`menu class:     ${String(menu)}`)

for (const [label, selector] of [['menu', menu], ['menuItem', menuItem]]) {
  if (selector === undefined) continue
  console.log(`\n--- ${label} ---`)
  for (const text of rule(selector)) console.log(text)
}
