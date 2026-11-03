// whale-meter：把「今天烧了多少 / 现在峰还是谷 / 折合多少钱」算出来。
//
// 四条规矩（都是栽过跟头换来的）：
//  1. 价目表必须来自官方页面（主人在 2026-11-02 指定的中文页），抓不到就标 stale，不用记忆里的数字乘。
//  2. 峰谷按官方中文页：北京时间 周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00 为高峰，
//     其余（含周末）为空闲。———— 我最早凭印象写的「00:30–08:30 是谷」是错的，已作废。
//  3. 官方中文页给的就是人民币，直接按元算，不套汇率。
//  4. 法定节假日与调休补班要查日历（timor.tech，按年取一次，存本地），不能只按星期几算。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PRICES_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
const HOLIDAY_URL = (year) => `https://timor.tech/api/holiday/year/${year}`
const HOME = process.env.USERPROFILE || os.homedir()

// 官方价目表（元 / 1M tokens），2026-11-02 抓取自上面那一页
const FALLBACK_PRICES = {
  model: 'deepseek-flash',
  cacheHit: { peak: 0.04, off: 0.02 },
  cacheMiss: { peak: 2, off: 1 },
  output: { peak: 8, off: 4 },
  currency: 'CNY',
  source: PRICES_URL,
  fetchedAt: '2026-11-02T10:20:00.000Z',
  stale: true,
}

const CACHE_MS = 6 * 60 * 60 * 1000
const state = {
  prices: FALLBACK_PRICES,
  pricesAt: 0,
  lastError: null,
  holidayYear: null,
  holidayMap: null,
  holidaySource: 'none',
  holidayError: null,
}

// ── 日历：查「今天是不是法定假日 / 补班」───────────────────────────────
async function loadHolidays(year) {
  if (state.holidayYear === year && state.holidayMap) return state
  const file = path.join(HOME, '.dsh', `whale-holidays-${year}.json`)
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    if (j && j.map && Object.keys(j.map).length) {
      state.holidayYear = year
      state.holidayMap = j.map
      state.holidaySource = 'local'
      return state
    }
  } catch {
    /* 没缓存就去抓 */
  }
  try {
    const res = await fetch(HOLIDAY_URL(year), { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const map = {}
    for (const [k, v] of Object.entries(j?.holiday || {})) {
      map[k] = { holiday: !!v.holiday, name: String(v.name || '') }
    }
    if (!Object.keys(map).length) throw new Error('日历返回为空')
    fs.writeFileSync(file, JSON.stringify({ year, map, fetchedAt: new Date().toISOString() }, null, 2), 'utf8')
    state.holidayYear = year
    state.holidayMap = map
    state.holidaySource = 'api'
  } catch (err) {
    state.holidayYear = year
    state.holidayMap = null
    state.holidaySource = 'none'
    state.holidayError = `日历抓取失败：${err.message}`
  }
  return state
}

function beijingParts(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const mm = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(bj.getUTCDate()).padStart(2, '0')
  return {
    day: bj.getUTCDay(),
    minutes: bj.getUTCHours() * 60 + bj.getUTCMinutes(),
    key: `${mm}-${dd}`,
    year: bj.getUTCFullYear(),
  }
}

function classifyDay(d, holidayMap) {
  const p = beijingParts(d)
  const info = holidayMap ? holidayMap[p.key] : null
  const weekend = p.day === 0 || p.day === 6
  // 日历说「是假日」→ 休息；日历说「不是假日」（补班日）→ 上班；没日历 → 按星期几
  const workday = info ? !info.holiday : !weekend
  const peak = workday && ((p.minutes >= 9 * 60 && p.minutes < 12 * 60) || (p.minutes >= 14 * 60 && p.minutes < 18 * 60))
  return {
    peak,
    workday,
    holidayName: info && info.holiday ? info.name : null,
    makeupDay: info && !info.holiday && weekend ? info.name || '补班' : null,
    hasCalendar: !!info,
  }
}

// ── 价目表：官方中文页 ────────────────────────────────────────────────
function parseFlashPrices(html) {
  // <td>空闲时段</td><td>0.02元</td><td>0.15元</td> … 高峰时段 … 未命中 … 输出 …
  const re = /(空闲时段|高峰时段)<\/td>\s*<td>\s*([0-9]+(?:\.[0-9]+)?)\s*元/gi
  const nums = [...html.matchAll(re)].map((m) => Number(m[2]))
  if (nums.length < 6) return null
  const [hitOff, hitPeak, missOff, missPeak, outOff, outPeak] = nums.slice(0, 6)
  const sane =
    hitOff > 0 &&
    hitOff < missOff &&
    missOff < outOff &&
    Math.abs(hitPeak - hitOff * 2) < 1e-9 &&
    Math.abs(missPeak - missOff * 2) < 1e-9 &&
    Math.abs(outPeak - outOff * 2) < 1e-9
  if (!sane) return null
  return {
    cacheHit: { peak: hitPeak, off: hitOff },
    cacheMiss: { peak: missPeak, off: missOff },
    output: { peak: outPeak, off: outOff },
  }
}

async function refreshPrices(force = false) {
  if (!force && state.pricesAt && Date.now() - state.pricesAt < CACHE_MS) return state.prices
  try {
    const res = await fetch(PRICES_URL, { headers: { 'user-agent': 'Mozilla/5.0' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const parsed = parseFlashPrices(html)
    if (!parsed) throw new Error('价目表结构变了，解析不出 flash 的三档价')
    state.prices = { ...FALLBACK_PRICES, ...parsed, stale: false, fetchedAt: new Date().toISOString() }
    state.pricesAt = Date.now()
    state.lastError = null
  } catch (err) {
    state.lastError = `价目表抓取失败：${err.message}`
    state.pricesAt = Date.now()
  }
  return state.prices
}

export async function computeMeter(watch, settings, now = new Date()) {
  const dayTokens = Number(watch?.dayTokens) || 0
  const budget = Number(settings?.dailyBudgetTokens) || 120000000
  const part = watch?.dayPart || null
  const prices = await refreshPrices()
  const p = beijingParts(now)
  await loadHolidays(p.year)
  const day = classifyDay(now, state.holidayMap)
  const band = day.peak ? 'peak' : 'off'

  let costCny = null
  if (part) {
    const hit = Number(part.cacheRead) || 0
    const miss = (Number(part.uncachedInput) || 0) + (Number(part.cacheWrite) || 0)
    const out = Number(part.output) || 0
    costCny = (hit * prices.cacheHit[band] + miss * prices.cacheMiss[band] + out * prices.output[band]) / 1e6
  }

  return {
    ok: true,
    at: now.toISOString(),
    dayTokens,
    budget,
    pct: budget > 0 ? Math.round((dayTokens / budget) * 1000) / 10 : null,
    offPeak: !day.peak,
    label: day.peak ? '峰' : '谷',
    peakWindow: '北京 工作日 09–12、14–18（法定假日全天谷，补班日算工作日）',
    day: {
      workday: day.workday,
      holidayName: day.holidayName,
      makeupDay: day.makeupDay,
      hasCalendar: day.hasCalendar,
      calendarSource: state.holidaySource,
      calendarError: state.holidayError,
    },
    part,
    // pass the not-yet-booked delta through, so the panel knows these numbers are not cold ledger data
    pendingTokens: Number(watch?.pendingTokens) || 0,
    lagSec: watch?.lagSec === undefined ? null : watch.lagSec,
    liveAt: watch?.liveAt || null,
    costCny: costCny === null ? null : Math.round(costCny * 100) / 100,
    prices: {
      model: prices.model,
      currency: prices.currency,
      stale: prices.stale,
      fetchedAt: prices.fetchedAt,
      source: PRICES_URL,
      table: prices,
    },
    note: part ? null : '今天还没有分类用量（明天起会累积）',
    error: state.lastError,
  }
}

// ── 实时预估（2026-11-02 加）────────────────────────────────────────────
// 问题：token-watch 每小时才跑一次，面板 20 秒轮询读的是同一份文件，
//   于是就出现「过了几十轮，数字还是一动不动」。
// 做法：面板自己扫一遍当前累计值，跟 watch.seen（上次记账时的快照）比，
//   把「还没入账的增量」加在返回值上。**只读，不写 STATE_FILE**——
//   记账仍然只有 token-watch 一个写者，避免两个写者互相覆盖。
//
// 代价：每次请求要读 ~20 个会话 json（每个几 KB–2MB）。加 5 秒缓存，
//   轮询频率 20 秒，实际最多每 5 秒读一次盘。
let liveCache = { at: 0, value: null }

export function liveWatch(watch, spendOf, scan, cfg, ttlMs = 5000) {
  const now = Date.now()
  if (liveCache.value && now - liveCache.at < ttlMs) return liveCache.value

  const base = watch || {}
  const state = {
    ...base,
    dayTokens: Number(base.dayTokens) || 0,
    dayPart: { ...(base.dayPart || { uncachedInput: 0, cacheRead: 0, output: 0, cacheWrite: 0 }) },
  }
  const seen = base.seen || {}
  let pending = 0
  try {
    const current = scan()
    for (const [name, cur] of current) {
      const prev = seen[name]
      const delta = prev ? Math.max(0, spendOf(cur, cfg) - spendOf(prev, cfg)) : spendOf(cur, cfg)
      if (delta > 0) pending += delta
      for (const key of ['uncachedInput', 'cacheRead', 'output', 'cacheWrite']) {
        const before = prev ? Number(prev[key]) || 0 : 0
        const added = Math.max(0, (Number(cur[key]) || 0) - before)
        if (added > 0) state.dayPart[key] = (Number(state.dayPart[key]) || 0) + added
      }
    }
  } catch {
    // 扫不动就退回账本里的数，别让面板整块挂掉
  }
  state.dayTokens += pending
  state.pendingTokens = pending
  state.liveAt = new Date().toISOString()
  state.lagSec = base.updatedAt ? Math.max(0, Math.round((now - Date.parse(base.updatedAt)) / 1000)) : null
  liveCache = { at: now, value: state }
  return state
}
