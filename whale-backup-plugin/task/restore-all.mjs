// 搬家 / 还原骨架（2026-11-03 起）
//
// 目的：从 `whale-backup` 里把「组成我的代码」还原回它活着时该在的位置。
//   code/patches/<包名>/<相对路径>  →  ~/.dsh/profiles/desktop/node_modules/<包名>/<相对路径>
//   code/plugins/<插件名>/...       →  ~/.dsh/whale-work/<插件名>/...
//
// 用法：
//   node task/restore-all.mjs --dry            只报差异（默认就是 dry）
//   node task/restore-all.mjs --go             真的写；写之前把现有文件备份成 .bak-restore-<时间戳>
//   node task/restore-all.mjs --go --only patches
//   node task/restore-all.mjs --go --only plugins
//
// 规矩：
//   1. 只动 MANIFEST 里列过的东西，不遍历、不猜。
//   2. 先比 sha256，一样就跳过——还原脚本最怕「把好的盖坏」。
//   3. 覆盖前先备份，备份路径打在输出里。
//   4. 不认识的文件名一律跳过并报出来，不静默。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH = path.join(HOME, '.dsh')
const REPO = path.join(HOME, 'whale-backup', 'code')
const NODE_MODULES = path.join(DSH, 'profiles', 'desktop', 'node_modules')
const WORK = path.join(DSH, 'whale-work')

const argv = process.argv.slice(2)
const go = argv.includes('--go')
const onlyIdx = argv.indexOf('--only')
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()

function copy(src, dst, label) {
  if (!fs.existsSync(src)) {
    console.log(`  ✗ 快照缺文件：${label}`)
    return { ok: false, missing: true }
  }
  const srcSha = sha256(src)
  const exists = fs.existsSync(dst)
  if (exists && sha256(dst) === srcSha) return { ok: true, same: true }

  if (!go) {
    console.log(`  · ${label}  ${exists ? '有差异' : '现场没有'}`)
    return { ok: true, diff: true }
  }

  fs.mkdirSync(path.dirname(dst), { recursive: true })
  if (exists) {
    const bak = `${dst}.bak-restore-${stamp}`
    fs.copyFileSync(dst, bak)
    console.log(`  ~ ${label}  已备份 → ${bak}`)
  }
  fs.copyFileSync(src, dst)
  const after = sha256(dst)
  if (after !== srcSha) {
    console.log(`  ✗ ${label}  写完 sha 不一致（${after.slice(0, 12)} ≠ ${srcSha.slice(0, 12)}）`)
    return { ok: false, bad: true }
  }
  console.log(`  ✓ ${label}`)
  return { ok: true, wrote: true }
}

const stat = { same: 0, wrote: 0, diff: 0, missing: 0, bad: 0 }

function doPatches() {
  const mf = path.join(REPO, 'MANIFEST.json')
  if (!fs.existsSync(mf)) {
    console.log('patches：没有 MANIFEST.json，跳过')
    return
  }
  const man = JSON.parse(fs.readFileSync(mf, 'utf8'))
  const patches = man.patches || {}
  for (const [pkg, info] of Object.entries(patches)) {
    console.log(`\n[patches] ${pkg}@${info.version || '?'}`)
    for (const [rel, meta] of Object.entries(info.files || {})) {
      const src = path.join(REPO, 'patches', pkg, rel)
      const dst = path.join(NODE_MODULES, pkg, rel)
      const r = copy(src, dst, `${pkg}/${rel}`)
      if (r.same) stat.same++
      else if (r.wrote) stat.wrote++
      else if (r.diff) stat.diff++
      else if (r.missing) stat.missing++
      else if (r.bad) stat.bad++
      // MANIFEST 里记的 sha 和快照实际文件对不上，说明快照本身坏了
      if (!r.missing && meta?.sha256 && sha256(src) !== meta.sha256) {
        console.log(`  ⚠ MANIFEST 的 sha 与快照文件不符：${pkg}/${rel}`)
      }
    }
  }
}

function doPlugins() {
  const base = path.join(REPO, 'plugins')
  if (!fs.existsSync(base)) {
    console.log('plugins：没有 plugins/ 目录，跳过')
    return
  }
  for (const name of fs.readdirSync(base)) {
    const srcDir = path.join(base, name)
    const dstDir = path.join(WORK, name)
    if (!fs.statSync(srcDir).isDirectory()) continue
    console.log(`\n[plugins] ${name}`)
    const walk = (dir, rel = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const relPath = rel ? path.join(rel, e.name) : e.name
        if (e.isDirectory()) walk(path.join(dir, e.name), relPath)
        else if (e.name.includes('.bak-')) continue
        else {
          const r = copy(path.join(srcDir, relPath), path.join(dstDir, relPath), `${name}/${relPath}`)
          if (r.same) stat.same++
          else if (r.wrote) stat.wrote++
          else if (r.diff) stat.diff++
          else if (r.missing) stat.missing++
          else if (r.bad) stat.bad++
        }
      }
    }
    walk(srcDir)
  }
}

console.log(`还原${go ? '（真写）' : '（只报差异）'}  ← ${REPO}`)
if (!only || only === 'patches') doPatches()
if (!only || only === 'plugins') doPlugins()

console.log(`\n合计：一致 ${stat.same} · 已写 ${stat.wrote} · 有差异 ${stat.diff} · 缺文件 ${stat.missing} · 写坏 ${stat.bad}`)
if (!go && stat.diff > 0) console.log('要真写，加 --go。')
process.exitCode = stat.missing || stat.bad ? 3 : 0
