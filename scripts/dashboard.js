import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'token-monitor')
const ledgerPath = join(dir, 'usage.jsonl')
const ratesPath = join(dir, 'rates.json')
const outputPath = join(dir, 'dashboard.html')

async function readLines(path) {
  try {
    return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function readRates() {
  try { return JSON.parse(await readFile(ratesPath, 'utf8')).models ?? {} }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error }
}

const rows = await readLines(ledgerPath)
const rates = await readRates()
const daily = new Map()
const models = new Map()
for (const row of rows) {
  const day = new Date(row.time).toISOString().slice(0, 10)
  const modelKey = `${row.provider}/${row.model}`
  const rate = rates[modelKey]
  const validRate = rate && ['input', 'output', 'cacheRead', 'cacheWrite']
    .every((key) => Number.isFinite(rate[key]) && rate[key] >= 0)
  const callCost = row.usageAvailable && validRate
    ? (row.inputTokens * rate.input + row.outputTokens * rate.output + row.cacheReadTokens * rate.cacheRead + row.cacheWriteTokens * rate.cacheWrite) / 1_000_000
    : null
  const dayData = daily.get(day) ?? { tokens: 0, calls: 0, cost: 0, priced: 0 }
  dayData.tokens += row.totalTokens
  dayData.calls += 1
  if (callCost !== null) { dayData.cost += callCost; dayData.priced += 1 }
  daily.set(day, dayData)
  const model = models.get(modelKey) ?? { calls: 0, usageCalls: 0, tokens: 0, cost: 0, priced: 0 }
  model.calls += 1
  if (row.usageAvailable) model.usageCalls += 1
  model.tokens += row.totalTokens
  if (callCost !== null) { model.cost += callCost; model.priced += 1 }
  models.set(modelKey, model)
}
const days = [...daily.entries()].sort(([a], [b]) => a.localeCompare(b))
const modelRows = [...models.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
const totalCalls = rows.length
const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0)
const knownCost = [...models.values()].reduce((sum, model) => sum + model.cost, 0)
const allPriced = models.size > 0 && [...models.values()].every((model) => model.priced === model.calls)
const costLabel = modelRows.length ? (allPriced ? `$${knownCost.toFixed(6)}` : `$${knownCost.toFixed(6)} +`) : '—'
const pricingNote = !modelRows.length
  ? '完成模型调用后，这里会显示逐模型统计。'
  : allPriced
    ? '所有模型均使用本地 rates.json 价格计算。'
    : '“价格/用量待补齐”表示部分调用缺少价格或提供方未返回 Token 用量；合计不包含这些调用。'
const labels = days.map(([day]) => day)
const vals = days.map(([, item]) => item.tokens)
const maxVal = Math.max(1, ...vals)
const W = 900, H = 250, pad = 38
const points = vals.map((v, i) => `${pad + (vals.length < 2 ? 0 : i * (W - 2 * pad) / (vals.length - 1))},${H - pad - (v / maxVal) * (H - 2 * pad)}`).join(' ')
const circles = vals.map((v, i) => {
  const x = pad + (vals.length < 2 ? 0 : i * (W - 2 * pad) / (vals.length - 1))
  const y = H - pad - (v / maxVal) * (H - 2 * pad)
  return `<circle cx="${x}" cy="${y}" r="4"><title>${labels[i]}: ${v.toLocaleString()} tokens</title></circle>`
}).join('')
const tickLabels = days.length > 8 ? days.filter((_, i) => i % Math.ceil(days.length / 8) === 0 || i === days.length - 1) : days
const xLabels = tickLabels.map(([day], _) => {
  const i = labels.indexOf(day), x = pad + (vals.length < 2 ? 0 : i * (W - 2 * pad) / (vals.length - 1))
  return `<text x="${x}" y="${H - 8}" text-anchor="middle">${day.slice(5)}</text>`
}).join('')
const table = modelRows.map(([key, model]) => `<tr><td>${escapeHtml(key)}</td><td>${model.calls}</td><td>${model.tokens.toLocaleString()} (${model.usageCalls} calls with usage)</td><td>${model.priced === model.calls ? '$' + model.cost.toFixed(6) : '价格/用量待补齐'}</td></tr>`).join('')
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Token Monitor</title><style>
:root{color-scheme:light;--ink:#17324d;--muted:#637486;--line:#dce6ec;--a:#167c91;--bg:#f3f7f9}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#243746;font:15px/1.5 system-ui,"Microsoft YaHei",sans-serif}.wrap{max-width:1050px;margin:34px auto;padding:0 22px}.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}h1{margin:0;color:var(--ink);font-size:26px}.sub{color:var(--muted);font-size:13px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:20px 0}.card,section{background:white;border:1px solid var(--line);border-radius:14px;padding:20px}.card span{display:block;color:var(--muted);font-size:13px}.card strong{display:block;color:var(--ink);font-size:26px;margin-top:7px}section{margin:16px 0}h2{font-size:17px;color:var(--ink);margin:0 0 16px}svg{display:block;width:100%;height:auto;overflow:visible}svg .grid{stroke:#e6eef2}svg polyline{fill:none;stroke:var(--a);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}svg circle{fill:var(--a)}svg text{font:11px system-ui;fill:var(--muted)}.empty{padding:42px;text-align:center;color:var(--muted)}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:11px;text-align:left}th{color:var(--muted);font-weight:600}.note{font-size:12px;color:var(--muted);margin-top:12px}@media(max-width:650px){.cards{grid-template-columns:1fr}.head{display:block}}
</style><body><main class="wrap"><div class="head"><div><h1>DSH Token Monitor</h1><div class="sub">本地用量概览 · 费用为估算值</div></div><div class="sub">生成时间 ${new Date().toLocaleString('zh-CN')}</div></div><div class="cards"><div class="card"><span>模型调用次数</span><strong>${totalCalls.toLocaleString()}</strong></div><div class="card"><span>累计 Token</span><strong>${totalTokens.toLocaleString()}</strong></div><div class="card"><span>已配置价格的估算费用</span><strong>${costLabel}</strong></div></div><section><h2>每日 Token 消耗</h2>${days.length ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日 token 消耗曲线"><line class="grid" x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}"/><line class="grid" x1="${pad}" y1="${pad}" x2="${W-pad}" y2="${pad}"/><polyline points="${points}"/>${circles}${xLabels}</svg>` : '<div class="empty">还没有记录。先在 Harness 中完成一次模型调用。</div>'}</section><section><h2>模型使用与成本</h2><table><thead><tr><th>提供方 / 模型</th><th>调用</th><th>Token</th><th>估算费用</th></tr></thead><tbody>${table || '<tr><td colspan="4">暂无数据</td></tr>'}</tbody></table><div class="note">${pricingNote}</div></section><div class="note">数据仅从本机 usage.jsonl 读取，不上传。费用按每百万 Token 的输入/输出/缓存单价估算；请以服务提供方账单为准。</div></main></body></html>`
await writeFile(outputPath, html, 'utf8')
console.log(`Dashboard generated: ${outputPath}`)

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}
