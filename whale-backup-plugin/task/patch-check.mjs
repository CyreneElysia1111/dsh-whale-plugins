#!/usr/bin/env node
// patch-check v1（2026-11-02）
//
// 用途：比对「备份仓库里 code/MANIFEST.json 记的补丁」和「现场 node_modules 里的文件」。
// 为什么要它：MANIFEST 落后时，插件一升级就会**静默覆盖**我改过的宿主文件，而那时
// 我多半已经忘了改过什么。这一版只报、不改——改不改、怎么改，由我看了再说。
//
// 用法：
//   node patch-check.mjs            # 人读的报告
//   node patch-check.mjs --json     # 机器读
//   node patch-check.mjs --quiet    # 只有差异时打一行，退出码 3
//
// 退出码：0 = 全部一致 / 3 = 有差异 / 1 = 运行出错

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const HOME = process.env.USERPROFILE || os.homedir()
const REPO = process.env.WHALE_BACKUP_DIR || path.join(HOME, 'whale-backup')
const MANIFEST = path.join(REPO, 'code', 'MANIFEST.json')
const PROFILE_NM = path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const quiet = args.includes('--quiet')

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) throw new Error(`找不到 MANIFEST：${MANIFEST}`)
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  if (!m || typeof m.patches !== 'object') throw new Error('MANIFEST 里没有 patches 段')
  return m.patches
}

function check() {
  const patches = loadManifest()
  const same = []
  const differ = []
  const missing = []

  for (const [pkg, entry] of Object.entries(patches)) {
    for (const [rel, meta] of Object.entries(entry.files || {})) {
      const live = path.join(PROFILE_NM, pkg, rel)
      const row = { pkg, rel, live, snapshotSha: meta.sha256, bytes: meta.bytes }
      if (!fs.existsSync(live)) {
        missing.push(row)
        continue
      }
      let liveSha
      try {
        liveSha = sha(live)
      } catch (error) {
        row.error = error.message
        missing.push(row)
        continue
      }
      row.liveSha = liveSha
      if (liveSha === String(meta.sha256).toUpperCase()) same.push(row)
      else differ.push(row)
    }
  }
  return { same, differ, missing }
}

function main() {
  const started = Date.now()
  let result
  try {
    result = check()
  } catch (error) {
    console.error(`patch-check 失败：${error.message}`)
    process.exit(1)
  }
  const { same, differ, missing } = result
  const total = same.length + differ.length + missing.length
  const bad = differ.length + missing.length

  if (asJson) {
    console.log(JSON.stringify({ total, same: same.length, differ, missing, ms: Date.now() - started }, null, 2))
  } else if (quiet) {
    console.log(bad === 0 ? `patch-check: ${total}/${total} 一致` : `patch-check: ${bad} 个不一致（${differ.length} 改动 / ${missing.length} 缺失）`)
  } else {
    console.log(`== patch-check ==  ${total} 个文件 · 一致 ${same.length} · 改动 ${differ.length} · 缺失 ${missing.length}`)
    for (const row of differ) {
      console.log(`  改了  ${row.pkg}/${row.rel}`)
      console.log(`        仓库 ${String(row.snapshotSha).slice(0, 12)}  现场 ${String(row.liveSha).slice(0, 12)}  ${row.live}`)
    }
    for (const row of missing) {
      console.log(`  缺了  ${row.pkg}/${row.rel}`)
      console.log(`        ${row.error || '文件不存在'}  ${row.live}`)
    }
    if (bad === 0) console.log('  全部一致 ✓')
    console.log(`（只报不改；要看差异内容：git -C "${REPO}" show HEAD:code/... ）`)
  }
  process.exit(bad === 0 ? 0 : 3)
}

main()
