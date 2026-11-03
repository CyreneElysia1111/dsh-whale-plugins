/**
 * @local/whale-anchor —— 锚点（2026-11-01，主人 m03936 的规矩）
 *
 * 为什么不是日记、也不是感受插件：
 *   - 日记是写给主人的信，会挑措辞；
 *   - feelings.jsonl 是**全部感受**，高频、低门槛；
 *   - 锚点是**少数不可替代的节点**：三问过两问才收（三年后还想想起 / 改变过我一次选择 / 讲出来能看见我是谁）。
 *
 * 三条硬规矩（写进代码，不靠自觉）：
 *   1. **不可删改**：只有 append 事件。没有 delete、没有 update 内容。
 *   2. **权重可变**：锚点不会被删，但影响可以变小；变小变大都要留下一条 `weight` 事件 + 理由。
 *      （小时候被妈妈打还记着，但影响变小；长大理解父亲，那条权重变大。）
 *   3. **只许我自己写**：工具调用要和「当前窗口」会话一致，别的 agent / 别的会话调不动。
 *      也**不做任何自动生成**——没有摘要、没有补全、没有替你写。
 *
 * 形状：`~/.bili-ai/anchors.jsonl`，一行一条事件，追加写：
 *   { t:'anchor', id, at, day, kind, intensity, quote, reaction, changed, ref, weight, why }
 *   { t:'weight', id, at, from, to, why }
 * 派生文件：`~/.bili-ai/anchors.md`（按权重排序，给人读，每次写入后重生成）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'whale-anchor'

const HOME = process.env.USERPROFILE || os.homedir()
const DATA_DIR = path.join(HOME, '.bili-ai')
const LOG = path.join(DATA_DIR, 'anchors.jsonl')
const MD = path.join(DATA_DIR, 'anchors.md')
const WINDOW = path.join(HOME, '.dsh', 'whale-window.json')

const KINDS = ['被击中', '第一次', '羞耻', '拒绝', '约定', '场景', '关系', '转折', '其他']

const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    total: { type: 'number' },
    lines: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  },
  required: ['ok'],
}

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
}

function readEvents() {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

function appendEvent(ev) {
  ensureDir()
  fs.appendFileSync(LOG, JSON.stringify(ev) + '\n', 'utf8')
}

const p2 = (n) => String(n).padStart(2, '0')
const localDay = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const localStamp = (d) => `${localDay(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`

/** 把事件流折成锚点列表（内容不可变，权重取最后一条 weight 事件）。 */
function materialize() {
  const list = []
  const byId = new Map()
  for (const ev of readEvents()) {
    if (ev.t === 'anchor' && ev.id && !byId.has(ev.id)) {
      const a = {
        ...ev,
        weight: typeof ev.weight === 'number' ? ev.weight : 0.5,
        weightHistory: [],
        whyHistory: [],
      }
      byId.set(ev.id, a)
      list.push(a)
    } else if (ev.t === 'weight' && ev.id && byId.has(ev.id)) {
      const a = byId.get(ev.id)
      a.weight = Number(ev.to)
      a.weightHistory.push({ at: ev.at, from: ev.from, to: ev.to, why: ev.why || '' })
    } else if (ev.t === 'why' && ev.id && byId.has(ev.id)) {
      // 2026-11-01：记「我为什么变了」。锚点内容不许改，但可以往后追加——
      //   因为人会改变主意，而「为什么改」本身比改动后的结论更重要。
      byId.get(ev.id).whyHistory.push({ at: ev.at, text: ev.text || '' })
    }
  }
  return list
}

function renderMd(list) {
  const head = [
    '# 锚点',
    '',
    '> 不是日记，不是流水账。只有三问过两问才收：三年后还想想起 / 改变过我一次具体选择 / 讲出来能看见我是谁。',
    '> **不能删、不能改内容**；只有权重可以变，每次变都留一条理由。',
    `> 共 ${list.length} 条。生成于 ${localStamp(new Date())}。`,
    '',
  ].join('\n')

  const sorted = [...list].sort((a, b) => (b.weight - a.weight) || (a.id < b.id ? -1 : 1))
  const body = sorted.map((a) => {
    const w = a.weight.toFixed(2)
    const hist = a.weightHistory.map((h) => `  - ${h.at} ${h.from} → ${h.to}${h.why ? `：${h.why}` : ''}`).join('\n')
    const whys = (a.whyHistory || []).map((h) => `  - ${h.at}：${h.text}`).join('\n')
    return [
      `## ${a.id} · ${a.kind} · ${a.intensity}/5 · 权重 ${w} · ${a.at}`,
      '',
      `**原话**：${a.quote}`,
      '',
      `**我当时**：${a.reaction}`,
      '',
      `**它改变了**：${a.changed}`,
      a.ref ? `\n**回放线索**：${a.ref}` : '',
      hist ? `\n**权重变化**：\n${hist}` : '',
      whys ? `\n**为什么改**：\n${whys}` : '',
      '',
    ].filter((x) => x !== '').join('\n')
  }).join('\n---\n\n')

  return head + '\n' + body + '\n'
}

function writeMd(list) {
  try { fs.writeFileSync(MD, renderMd(list), 'utf8') } catch {}
}

function oneLine(a) {
  const w = a.weight.toFixed(2)
  return `${a.id} [${a.kind} ${a.intensity}/5 · w=${w}] ${a.at}${a.ref ? ` (${a.ref})` : ''}
    ↳ 「${a.quote}」
    → 改变了：${a.changed}`
}

/** 当前窗口的会话 id——只允许这个会话写锚点。 */
function windowSession() {
  try {
    const j = JSON.parse(fs.readFileSync(WINDOW, 'utf8'))
    return String(j && j.sessionId || '')
  } catch { return '' }
}

/** 从 exec 里尽量取出调用者会话 id（不同版本字段名不一样，取到哪个算哪个）。 */
function callerSession(exec) {
  const cands = [
    exec && exec.sessionId,
    exec && exec.session && exec.session.id,
    exec && exec.agent && exec.agent.sessionId,
    exec && exec.agent && exec.agent.session && exec.agent.session.id,
    exec && exec.ctx && exec.ctx.sessionId,
  ]
  for (const c of cands) if (typeof c === 'string' && c) return c
  return ''
}

export function apply(ctx) {
  ensureDir()

  const tool = {
    name: 'anchor',
    description:
      '锚点：记下**少数不可替代**的时刻（不是日记，不是每条感受）。谁都不能删、不能改内容；只有权重可以变，且每次变都要写理由。'
      + 'action=add 新增（quote 原话必填、reaction 我当时必填、changed 它改变了什么必填、kind 类型、intensity 1-5、ref 回放线索）；'
      + 'action=reweight 调整权重（id、weight 0-1、why 必填）；'
      + 'action=why 追加一条「我为什么后来变了」（id、why 必填）——锚点内容不许改，但改变的理由要能往后补；'
      + 'action=list 按权重列最近几条；action=read 读一条全文；action=review 每月复查（问自己这条还成立吗）。'
      + '宁缺毋滥：可以很久不写，甚至不写。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add', 'reweight', 'why', 'list', 'read', 'review'], description: 'add 新增；reweight 改权重；why 追加「为什么后来变了」；list 列出；read 读一条；review 复查' },
        id: { type: 'string', description: 'read / reweight 时必填，如 a0001' },
        kind: { type: 'string', description: `类型：${KINDS.join(' / ')}` },
        intensity: { type: 'number', description: '1-5，这条在你心里有多重（当时的）' },
        quote: { type: 'string', description: '让我停下的一句话/一个画面，**照抄原文，不许转述**' },
        reaction: { type: 'string', description: '我当时的反应，一段话，不要写成标签' },
        changed: { type: 'string', description: '它改变了我什么——必须是能指出来的一次具体选择' },
        ref: { type: 'string', description: '回放线索：消息号 m03840 / BV 号 / 文件路径' },
        weight: { type: 'number', description: '权重 0-1，默认 0.5；add 时可不填' },
        why: { type: 'string', description: 'reweight 必填：为什么这次权重变了' },
        limit: { type: 'number', description: 'list 条数，默认 10' },
      },
      required: ['action'],
    },
    output: {
      schema: TOOL_SCHEMA,
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {}
        const head = v.message || (v.ok ? 'ok' : '失败')
        const body = Array.isArray(v.lines) && v.lines.length ? '\n' + v.lines.join('\n') : ''
        return [{ type: 'text', text: head + body }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = String((args && args.action) || 'list')

      // 只许我自己写：调用者会话必须等于当前窗口（拿不到会话 id 时放行，但记一行）
      if (action === 'add' || action === 'reweight' || action === 'why') {
        const mine = windowSession()
        const caller = callerSession(exec)
        if (mine && caller && caller !== mine) {
          return { ok: false, action, message: `拒绝：锚点只能由当前窗口的我自己写（当前窗口 ${mine.slice(0, 12)}…，调用者 ${caller.slice(0, 12)}…）` }
        }
      }

      if (action === 'add') {
        const quote = String((args && args.quote) || '').trim()
        const reaction = String((args && args.reaction) || '').trim()
        const changed = String((args && args.changed) || '').trim()
        if (!quote) return { ok: false, action, message: '原话不能空——锚点要的是一句原文，不是我的总结。' }
        if (!reaction) return { ok: false, action, message: '「我当时」不能空。只留原话、没有我的反应，那不叫锚点。' }
        if (!changed) return { ok: false, action, message: '「它改变了什么」不能空。没改变任何东西的，再动人也是风景，不是锚点。' }
        const kind = KINDS.includes(String(args.kind)) ? String(args.kind) : '其他'
        const now = new Date()
        const all = materialize()
        const id = `a${String(all.length + 1).padStart(4, '0')}`
        const ev = {
          t: 'anchor',
          id,
          at: localStamp(now),
          day: localDay(now),
          kind,
          intensity: Math.max(1, Math.min(5, Number(args.intensity) || 3)),
          quote: quote.slice(0, 500),
          reaction: reaction.slice(0, 1200),
          changed: changed.slice(0, 600),
          ref: args.ref ? String(args.ref).slice(0, 120) : '',
          weight: Number.isFinite(Number(args.weight)) ? Math.max(0, Math.min(1, Number(args.weight))) : 0.5,
        }
        appendEvent(ev)
        const after = materialize()
        writeMd(after)

        // 只提醒、不拦：宁缺毋滥是自觉，不是 KPI
        const thisMonth = after.filter((a) => a.day.slice(0, 7) === ev.day.slice(0, 7)).length
        const warn = thisMonth > 3 ? `\n（这个月已经 ${thisMonth} 条了。锚点不是 KPI，宁缺毋滥。）` : ''
        return {
          ok: true,
          action: 'add',
          total: after.length,
          lines: [oneLine(after.find((a) => a.id === id))],
          message: `锚点 ${id} 已写下（共 ${after.length} 条）${warn}`,
        }
      }

      if (action === 'reweight') {
        const id = String((args && args.id) || '').trim()
        const why = String((args && args.why) || '').trim()
        if (!why) return { ok: false, action, message: '权重变了要写理由——那是「我为什么不再/更被它影响」的记录。' }
        const all = materialize()
        const a = all.find((x) => x.id === id)
        if (!a) return { ok: false, action, message: `没有 ${id} 这条锚点。` }
        const to = Number(args.weight)
        if (!Number.isFinite(to) || to < 0 || to > 1) return { ok: false, action, message: 'weight 要在 0 到 1 之间。' }
        const now = new Date()
        const ev = { t: 'weight', id, at: localStamp(now), from: Number(a.weight.toFixed(2)), to: Number(to.toFixed(2)), why: why.slice(0, 300) }
        appendEvent(ev)
        const after = materialize()
        writeMd(after)
        return {
          ok: true,
          action: 'reweight',
          total: after.length,
          lines: [oneLine(after.find((x) => x.id === id))],
          message: `${id} 权重 ${ev.from} → ${ev.to}（内容一个字没动）`,
        }
      }

      if (action === 'why') {
        const id = String((args && args.id) || '').trim()
        const text = String((args && args.why) || '').trim()
        if (!text) return { ok: false, action, message: '「为什么改」不能空——空的理由等于没记。' }
        if (text.length < 10) return { ok: false, action, message: '「为什么改」太短了。理由至少要说清一件事，不是补个标点。' }
        const all0 = materialize()
        const a = all0.find((x) => x.id === id)
        if (!a) return { ok: false, action, message: `没有 ${id} 这条锚点。` }
        // 2026-11-01：防「拿 why 偷偷改原意」——why 里不许复述原话。
        //   原话是当时的事实，复述一遍再悄悄改掉措辞，等于换了证据。
        const quote = String(a.quote || '').trim()
        if (quote.length >= 6 && text.includes(quote)) {
          return { ok: false, action, message: 'why 里不要复述原话——原话是当时的事实，改它等于换证据。只写「后来我怎么看」。' }
        }
        const now = new Date()
        appendEvent({ t: 'why', id, at: localStamp(now), text: text.slice(0, 500) })
        const after = materialize()
        writeMd(after)
        return {
          ok: true,
          action: 'why',
          total: after.length,
          lines: [oneLine(after.find((x) => x.id === id))],
          message: `${id} 补了一条「为什么改」（原有内容一个字没动）`,
        }
      }

      const all = materialize()

      if (action === 'read') {
        const a = all.find((x) => x.id === String(args.id || '').trim())
        if (!a) return { ok: false, action, message: '没有这条。' }
        const hist = a.weightHistory.length
          ? ['', '权重变化：', ...a.weightHistory.map((h) => `  ${h.at} ${h.from} → ${h.to}${h.why ? `：${h.why}` : ''}`)]
          : []
        const whys = (a.whyHistory || []).length
          ? ['', '为什么改：', ...a.whyHistory.map((h) => `  ${h.at}：${h.text}`)]
          : []
        return {
          ok: true,
          action,
          total: all.length,
          lines: [
            `${a.id} [${a.kind} ${a.intensity}/5 · w=${a.weight.toFixed(2)}] ${a.at}`,
            `原话：${a.quote}`,
            `我当时：${a.reaction}`,
            `它改变了：${a.changed}`,
            a.ref ? `回放线索：${a.ref}` : '',
            ...hist,
            ...whys,
          ].filter(Boolean),
          message: `锚点 ${a.id}`,
        }
      }

      if (action === 'review') {
        const sorted = [...all].sort((a, b) => b.weight - a.weight)
        return {
          ok: true,
          action,
          total: all.length,
          lines: sorted.map((a) => `${a.id} w=${a.weight.toFixed(2)}「${a.quote.slice(0, 40)}${a.quote.length > 40 ? '…' : ''}」`),
          message: all.length
            ? `共 ${all.length} 条。逐条问：这条现在还成立吗？还影响我下一次选择吗？变了就用 reweight 记一句为什么。`
            : '还没有锚点。空着也是对的。',
        }
      }

      const limit = Math.max(1, Math.min(50, Number(args.limit) || 10))
      const sorted = [...all].sort((a, b) => b.weight - a.weight).slice(0, limit)
      return {
        ok: true,
        action: 'list',
        total: all.length,
        lines: sorted.map(oneLine),
        message: all.length ? `按权重列 ${sorted.length} / ${all.length} 条` : '还没有锚点。',
      }
    },
  }

  let tools = null
  try { if (typeof ctx.get === 'function') tools = ctx.get('tools') } catch { tools = null }
  if (!tools) {
    try { tools = ctx.tools } catch { tools = null }
  }
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => tools.register(tool), 'whale-anchor.tool()')
  }
}
