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

const bundle = 'C:/Users/LIU/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BKQ_L1z6.js'
const source = readFileSync(bundle, 'utf8')

const rule = (selector) => {
  const pattern = new RegExp(`\\.${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[:.][^{,]*)?\\{[^}]*\\}`, 'g')
  const found = source.match(pattern)
  return found ?? []
}

const menuItem = /_menuItem_[A-Za-z0-9]+/.exec(source)?.[0]
const menu = /[^-]_menu_[A-Za-z0-9]+/.exec(source)?.[0]?.slice(1)
console.log(`menuItem class: ${String(menuItem)}`)
console.log(`menu class:     ${String(menu)}`)

for (const [label, selector] of [['menu', menu], ['menuItem', menuItem]]) {
  if (selector === undefined) continue
  console.log(`\n--- ${label} ---`)
  for (const text of rule(selector)) console.log(text)
}
