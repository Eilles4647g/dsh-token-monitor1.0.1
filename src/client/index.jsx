import { useEffect, useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

export const name = 'dsh-token-monitor'
export const inject = ['slots', 'sessions']

const PANEL = 'dsh-token-monitor'
const CACHE_KEY = 'dsh-token-monitor:v1:usage'
const RATES_KEY = 'dsh-token-monitor:v1:rates'
const RECENT_LIMIT = 30
const zero = () => ({ calls: 0, usageCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0 })

function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
    if (value?.version === 1 && value.sessions && typeof value.sessions === 'object') return value
  } catch {}
  return { version: 1, sessions: {} }
}
function writeCache(value) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)) } catch {} }
function readRates() {
  try {
    const value = JSON.parse(localStorage.getItem(RATES_KEY) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function writeRates(value) { try { localStorage.setItem(RATES_KEY, JSON.stringify(value)) } catch {} }
function emptySession() {
  return { lastSeq: -1, liveStartSeq: 0, route: null, models: {}, days: {}, recent: [] }
}
function validCount(value) { return Number.isSafeInteger(value) && value >= 0 }
function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null
  const input = value.inputTokens, output = value.outputTokens
  const cacheRead = value.cacheReadTokens ?? 0, cacheWrite = value.cacheWriteTokens ?? 0
  if (![input, output, cacheRead, cacheWrite].every(validCount)) return null
  const total = input + output + cacheRead + cacheWrite
  return Number.isSafeInteger(total) ? { input, output, cacheRead, cacheWrite, total } : null
}
function usageOf(event) {
  const direct = normalizeUsage(event.data?.usage)
  if (direct) return direct
  const stream = event.data?.stream
  if (Array.isArray(stream)) {
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      if (stream[i]?.type === 'usage') {
        const usage = normalizeUsage(stream[i].usage)
        if (usage) return usage
      }
    }
  }
  return null
}
function routeOf(header) {
  const config = header?.config ?? header ?? {}
  const provider = typeof config.provider === 'string' ? config.provider : ''
  const model = typeof config.model === 'string' ? config.model : ''
  return provider || model ? { provider: provider || 'unknown', model: model || 'unknown' } : null
}
function modelKey(route) { return ``${route.provider || 'unknown'}/${route.model || 'unknown'}`` }
function addUsage(counter, usage) {
  counter.calls += 1
  if (!usage) return
  counter.usageCalls += 1
  counter.input += usage.input
  counter.output += usage.output
  counter.cacheRead += usage.cacheRead
  counter.cacheWrite += usage.cacheWrite
  counter.tokens += usage.total
}
function recordEvent(saved, event) {
  if (event.type === 'request/header') {
    saved.route = routeOf(event.data?.header)
    return
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
  const data = event.data ?? {}
  const route = routeOf(data.message) ?? saved.route ?? { provider: 'unknown', model: 'unknown' }
  const usage = usageOf(event)
  const key = modelKey(route)
  const day = new Date(Number(event.time) || 0).toISOString().slice(0, 10)
  const record = {
    id: String(event.seq), time: Number(event.time) || 0, provider: route.provider, model: route.model,
    attempt: event.type === 'assistant/attempt', usageAvailable: usage !== null,
    input: usage?.input ?? 0, output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0, tokens: usage?.total ?? 0,
  }
  const model = saved.models[key] ??= zero()
  addUsage(model, usage)
  const daily = saved.days[day] ??= {}
  const dayModel = daily[key] ??= zero()
  addUsage(dayModel, usage)
  saved.recent.push(record)
  if (saved.recent.length > RECENT_LIMIT) saved.recent.splice(0, saved.recent.length - RECENT_LIMIT)
}
function durableEvents(window) {
  return window.entries.filter(item => item?.type === 'event' && item.event && Number.isSafeInteger(item.event.seq)).map(item => item.event)
}
function minSeq(events) { return events.length ? Number(events[0].seq) : Infinity }

/** Read history, retaining only route, time and usage fields in browser storage. */
async function scanSessions(sessions, onProgress) {
  await sessions.refresh()
  const ids = (sessions.list.getSnapshot()?.ids ?? []).map(String)
  const cache = readCache()
  let failed = 0

  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]
    onProgress?.({ done: i, total: ids.length })
    const reference = sessions.retain(id, { source: 'tokenMonitor' })
    try {
      const binding = await reference.ready
      const session = binding.session
      if (session.getSnapshot().openState !== 'open') { failed += 1; continue }

      const saved = cache.sessions[id] ?? emptySession()
      let window = binding.eventSource.getSnapshot()
      let events = durableEvents(window)
      let earliest = minSeq(events)
      let incomplete = false
      // Read all pages on first view; later refresh only pages that can contain new events.
      while (window.hasMore && (saved.lastSeq < 0 || earliest > saved.lastSeq)) {
        const revision = window.revision
        await session.loadOlder()
        window = binding.eventSource.getSnapshot()
        if (window.revision === revision) { incomplete = true; break }
        if (window.change?.kind === 'prepend') {
          const older = window.change.entries.filter(item => item?.type === 'event' && item.event).map(item => item.event)
          earliest = Math.min(earliest, minSeq(older))
        } else {
          events = durableEvents(window)
          earliest = minSeq(events)
        }
      }
      events = durableEvents(window)
      for (const event of events) {
        if (event.type === 'session/end-seed' && event.data?.inherited === true) {
          saved.liveStartSeq = Number(event.seq) + 1
        }
      }
      let max = saved.lastSeq
      for (const event of events) {
        const seq = Number(event.seq)
        max = Math.max(max, seq)
        if (seq <= saved.lastSeq || seq < saved.liveStartSeq) continue
        recordEvent(saved, event)
      }
      saved.lastSeq = max
      cache.sessions[id] = saved
      writeCache(cache)
      if (incomplete) failed += 1
    } catch { failed += 1 }
    finally { reference.release() }
    onProgress?.({ done: i + 1, total: ids.length })
  }
  return { cache, ids, failed }
}

function completeRate(rate) {
  return rate && ['input', 'output', 'cacheRead', 'cacheWrite'].every(
    field => typeof rate[field] === 'number' && Number.isFinite(rate[field]) && rate[field] >= 0,
  )
}
function costOf(data, rate) {
  if (!completeRate(rate) || !data.usageCalls) return null
  return (data.input * rate.input + data.output * rate.output
    + data.cacheRead * rate.cacheRead + data.cacheWrite * rate.cacheWrite) / 1_000_000
}
function merge(into, from) {
  for (const key of ['calls', 'usageCalls', 'input', 'output', 'cacheRead', 'cacheWrite', 'tokens']) into[key] += from[key]
}
function summarize(cache, ids, rates) {
  const models = new Map(), days = new Map(), recent = []
  for (const id of ids) {
    const saved = cache.sessions[id]
    if (!saved) continue
    for (const [key, value] of Object.entries(saved.models ?? {})) {
      const total = models.get(key) ?? zero()
      merge(total, value); models.set(key, total)
    }
    for (const [day, modelMap] of Object.entries(saved.days ?? {})) {
      const total = days.get(day) ?? { tokens: 0, calls: 0 }
      for (const [key, value] of Object.entries(modelMap)) {
        total.tokens += value.tokens; total.calls += value.calls
        const cost = costOf(value, rates[key])
        if (cost !== null) total.cost = (total.cost ?? 0) + cost
      }
      days.set(day, total)
    }
    recent.push(...(saved.recent ?? []))
  }
  const modelRows = [...models].map(([key, value]) => ({ key, ...value, cost: costOf(value, rates[key]) }))
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls)
  const totalCalls = modelRows.reduce((sum, item) => sum + item.calls, 0)
  const totalTokens = modelRows.reduce((sum, item) => sum + item.tokens, 0)
  const knownCost = modelRows.reduce((sum, item) => sum + (item.cost ?? 0), 0)
  const allPriced = totalCalls > 0 && modelRows.every(item => item.cost !== null && item.calls === item.usageCalls)
  return {
    modelRows, totalCalls, totalTokens, knownCost, allPriced,
    dayRows: [...days].sort(([a], [b]) => a.localeCompare(b)),
    recentRows: recent.sort((a, b) => b.time - a.time).slice(0, 20),
  }
}
const number = value => Number(value || 0).toLocaleString('zh-CN')
const money = value => ``$${Number(value || 0).toFixed(6)}``
const muted = { color: 'var(--dsh-text-secondary, #66717c)', fontSize: 12 }
const th = { textAlign: 'left', padding: '9px 10px', borderBottom: '1px solid var(--dsh-border, #d7dce2)', color: 'var(--dsh-text-secondary, #66717c)' }
const td = { padding: '9px 10px', borderBottom: '1px solid var(--dsh-border, #d7dce2)' }
const modelStyle = { ...td, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13, whiteSpace: 'nowrap' }

function Trend({ days }) {
  const rows = days.slice(-180)
  if (!rows.length) return jsx('div', { style: { padding: 30, textAlign: 'center', ...muted }, children: '完成模型调用后，这里会显示历史曲线。' })
  const start = new Date(``${rows[0][0]}T00:00:00Z``)
  const last = new Date(``${rows.at(-1)[0]}T00:00:00Z``)
  const span = Math.max(1, Math.round((last - start) / 86400000) + 1)
  const dayMap = new Map(rows)
  const points = Array.from({ length: span }, (_, i) => {
    const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10)
    return [date, dayMap.get(date)?.tokens ?? 0]
  })
  const W = 900, H = 220, L = 48, R = 14, T = 14, B = 32
  const max = Math.max(1, ...points.map(([, value]) => value))
  const plotW = W - L - R, plotH = H - T - B
  const coords = points.map(([, value], i) => {
    const x = L + (points.length < 2 ? plotW / 2 : i * plotW / (points.length - 1))
    const y = T + plotH - value * plotH / max
    return [x, y]
  })
  return jsxs('svg', {
    viewBox: ``0 0 ${W} ${H}``, role: 'img', 'aria-label': '每日 Token 消耗曲线，最多 180 天',
    style: { display: 'block', width: '100%', minHeight: 160 },
    children: [
      jsx('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, stroke: 'var(--dsh-border, #d7dce2)' }),
      jsx('line', { x1: L, y1: T, x2: W - R, y2: T, stroke: 'var(--dsh-border, #d7dce2)' }),
      jsx('polyline', { points: coords.map(([x, y]) => ``${x},${y}``).join(' '), fill: 'none', stroke: 'var(--dsh-accent, #2b83a5)', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ...points.length <= 40 ? coords.map(([x, y], i) => jsx('circle', {
        cx: x, cy: y, r: 3, children: jsx('title', { children: ``${points[i][0]}：${number(points[i][1])} Token`` }),
      }, points[i][0])) : [],
      jsx('text', { x: L, y: H - 7, fill: 'var(--dsh-text-secondary, #66717c)', fontSize: 12, children: points[0][0] }),
      jsx('text', { x: W - R, y: H - 7, textAnchor: 'end', fill: 'var(--dsh-text-secondary, #66717c)', fontSize: 12, children: points.at(-1)[0] }),
      jsx('text', { x: 2, y: T + 4, fill: 'var(--dsh-text-secondary, #66717c)', fontSize: 12, children: number(max) }),
    ],
  })
}
function RateInput({ rate, field, label, update }) {
  return jsxs('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }, children: [
    jsx('span', { style: muted, children: label }),
    jsx('input', {
      type: 'number', min: '0', step: '0.000001', value: rate?.[field] ?? '',
      'aria-label': label, onChange: event => update(field, event.target.value),
      style: { width: '100%', minWidth: 70, boxSizing: 'border-box', border: '1px solid var(--dsh-border, #c8d0d8)', borderRadius: 6, padding: 6, background: 'var(--dsh-bg, #fff)', color: 'inherit' },
    }),
  ] })
}
function card(label, value, note) {
  return jsxs('div', { style: { border: '1px solid var(--dsh-border, #d7dce2)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 7, background: 'var(--dsh-bg-secondary, #fff)' }, children: [
    jsx('span', { style: muted, children: label }),
    jsx('strong', { style: { fontSize: 25 }, children: value }),
    jsx('span', { style: muted, children: note }),
  ] })
}
function header(labels) { return jsx('tr', { children: labels.map((label, i) => jsx('th', { style: th, children: label }, i)) }) }

function Dashboard({ refresh }) {
  const initial = useMemo(() => readCache(), [])
  const [cache, setCache] = useState(initial)
  const [ids, setIds] = useState(Object.keys(initial.sessions ?? {}))
  const [rates, setRates] = useState(() => readRates())
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('正在准备会话列表…')
  const [error, setError] = useState('')
  const stats = useMemo(() => summarize(cache, ids, rates), [cache, ids, rates])

  const runScan = async () => {
    if (busy) return
    setBusy(true); setError(''); setStatus('正在读取 DSH 会话历史…')
    try {
      const result = await refresh(progress => {
        setStatus(progress.total ? ``扫描会话 ${progress.done}/${progress.total}…`` : '没有可读取的会话。')
      })
      setCache(result.cache); setIds(result.ids)
      setStatus(result.failed
        ? ``扫描结束：${result.ids.length} 个会话，${result.failed} 个读取不完整；可再次刷新重试。``
        : ``已扫描 ${result.ids.length} 个会话。``)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('读取失败，请检查 DSH 状态后重试。')
    } finally { setBusy(false) }
  }
  useEffect(() => { void runScan() }, [])

  const updateRate = (key, field, text) => {
    setRates(previous => {
      const next = { ...previous }, rate = { ...(next[key] ?? {}) }
      if (text === '') delete rate[field]
      else {
        const value = Number(text)
        if (!Number.isFinite(value) || value < 0) return previous
        rate[field] = value
      }
      if (Object.keys(rate).length) next[key] = rate
      else delete next[key]
      writeRates(next)
      return next
    })
  }
  const sections = { border: '1px solid var(--dsh-border, #d7dce2)', borderRadius: 12, padding: 16, margin: '12px 0', background: 'var(--dsh-bg-secondary, #fff)' }
  const title = { margin: '0 0 13px', fontSize: 17, fontWeight: 620 }
  const moneyLabel = stats.totalCalls ? ``${money(stats.knownCost)}${stats.allPriced ? '' : ' 起'}`` : '—'

  return jsxs('div', { style: { boxSizing: 'border-box', height: '100%', minHeight: '100%', overflow: 'auto', padding: '24px clamp(16px, 3vw, 36px)', color: 'var(--dsh-text, #20252b)', fontFamily: 'var(--dsh-font-family-sans, system-ui, sans-serif)' }, children: [
    jsxs('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 14 }, children: [
      jsxs('div', { children: [
        jsx('h1', { style: { margin: '0 0 5px', fontSize: 24, fontWeight: 650 }, children: 'DSH Token Monitor' }),
        jsx('div', { style: muted, children: '会话用量、模型成本与历史趋势 · 统计缓存在当前浏览器配置中' }),
      ] }),
      jsx('button', { onClick: runScan, disabled: busy, style: { border: '1px solid var(--dsh-border, #c8d0d8)', borderRadius: 8, padding: '8px 13px', background: 'var(--dsh-bg-secondary, #f7f8fa)', color: 'inherit', cursor: 'pointer' }, children: busy ? '正在扫描…' : '刷新统计' }),
    ] }),
    jsxs('div', { role: 'status', style: { ...muted, minHeight: 22, marginBottom: 10 }, children: [
      status, error ? jsx('div', { role: 'alert', style: { color: '#b42318', marginTop: 6 }, children: error }) : null,
    ] }),
    jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }, children: [
      card('模型调用次数', number(stats.totalCalls), '包含助手成功调用与失败重试'),
      card('累计 Token', number(stats.totalTokens), '仅累加模型提供用量的调用'),
      card('估算成本', moneyLabel, 'USD；未配置价格或缺少用量时显示“起”'),
    ] }),
    jsxs('section', { style: sections, children: [
      jsx('h2', { style: title, children: '历史 Token 消耗' }),
      jsx(Trend, { days: stats.dayRows }),
      jsx('div', { style: muted, children: '按日汇总，最多展示最近 180 天。新增调用后点击“刷新统计”。' }),
    ] }),
    jsxs('section', { style: sections, children: [
      jsx('h2', { style: title, children: '模型调用、Token 与成本' }),
      jsx('div', { style: { overflowX: 'auto' }, children: jsxs('table', { style: tableStyle, children: [
        jsx('thead', { children: header(['提供方 / 模型', '调用', '有用量', '输入', '输出', '缓存读 / 写', '估算费用']) }),
        jsx('tbody', { children: stats.modelRows.length ? stats.modelRows.map(item => jsx('tr', { children: [
          jsx('td', { style: modelStyle, children: item.key }),
          jsx('td', { style: td, children: number(item.calls) }),
          jsx('td', { style: td, children: ``${number(item.usageCalls)} / ${number(item.calls)}`` }),
          jsx('td', { style: td, children: number(item.input) }),
          jsx('td', { style: td, children: number(item.output) }),
          jsx('td', { style: td, children: ``${number(item.cacheRead)} / ${number(item.cacheWrite)}`` }),
          jsx('td', { style: td, children: item.cost === null ? '未配置完整价格' : ``${money(item.cost)}${item.usageCalls < item.calls ? '（部分调用无用量）' : ''}`` }),
        ] }, item.key)) : jsx('tr', { children: jsx('td', { colSpan: 7, style: { ...td, textAlign: 'center', padding: 24 }, children: '暂时没有调用记录。首次扫描会从会话历史读取。' }) }) }),
      ] }) }),
      stats.modelRows.length ? jsxs('div', { style: { marginTop: 16, borderTop: '1px solid var(--dsh-border, #d7dce2)', paddingTop: 14 }, children: [
        jsx('strong', { children: '价格设置（USD / 百万 Token）' }),
        jsx('div', { style: { ...muted, margin: '5px 0 10px' }, children: '填写各模型的输入、输出、缓存读、缓存写单价。只保存在本机；成本是估算值，不是账单。' }),
        ...stats.modelRows.map(item => jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(160px, 2fr) repeat(4, minmax(80px, 1fr))', gap: 8, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--dsh-border, #d7dce2)', overflowX: 'auto' }, children: [
          jsx('span', { style: { ...muted, fontFamily: 'ui-monospace, Consolas, monospace' }, children: item.key }),
          ...[['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写']].map(([field, label]) => jsx(RateInput, {
            rate: rates[item.key], field, label, update: (f, value) => updateRate(item.key, f, value),
          }, field)),
        ] }, item.key)),
      ] }) : null,
    ] }),
    jsxs('section', { style: sections, children: [
      jsx('h2', { style: title, children: '最近调用' }),
      jsx('div', { style: { overflowX: 'auto' }, children: jsxs('table', { style: tableStyle, children: [
        jsx('thead', { children: header(['时间', '模型', '类型', '输入', '输出', '总 Token']) }),
        jsx('tbody', { children: stats.recentRows.length ? stats.recentRows.map(item => jsx('tr', { children: [
          jsx('td', { style: td, children: item.time ? new Date(item.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—' }),
          jsx('td', { style: modelStyle, children: ``${item.provider}/${item.model}`` }),
          jsx('td', { style: td, children: item.attempt ? '失败 / 重试' : '助手调用' }),
          jsx('td', { style: td, children: item.usageAvailable ? number(item.input) : '未上报' }),
          jsx('td', { style: td, children: item.usageAvailable ? number(item.output) : '未上报' }),
          jsx('td', { style: td, children: item.usageAvailable ? number(item.tokens) : '未上报' }),
        ] }, item.id + item.time)) : jsx('tr', { children: jsx('td', { colSpan: 6, style: { ...td, textAlign: 'center', padding: 24 }, children: '暂无最近调用记录。' }) }) }),
      ] }) }),
    ] }),
    jsx('footer', { style: { ...muted, lineHeight: 1.6, padding: '4px 2px 24px' }, children: '监控仅读取会话中的模型路由、时间和 Token 数，不保存提示词、回复内容、工具参数或密钥。关闭页面前点击刷新以同步最新结算记录。' }),
  ] })
}

function MonitorIcon({ size = 18 }) {
  return jsx('span', { 'aria-hidden': true, style: { fontSize: size, lineHeight: 1 }, children: '◷' })
}

export function apply(ctx) {
  const refresh = onProgress => scanSessions(ctx.sessions, onProgress)
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: PANEL, inject: () => ({ refresh }) }, Dashboard)
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL, order: 20, label: 'Token监控',
  }, MonitorIcon))
}

