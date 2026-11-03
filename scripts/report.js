import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'token-monitor')
const ledgerPath = join(base, 'usage.jsonl')
const ratesPath = join(base, 'rates.json')

async function readJsonLines(path) {
  try {
    const text = await readFile(path, 'utf8')
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function readRates() {
  try {
    const parsed = JSON.parse(await readFile(ratesPath, 'utf8'))
    return parsed.models ?? {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

const rows = await readJsonLines(ledgerPath)
const rates = await readRates()
const byModel = new Map()
const byDay = new Map()

for (const row of rows) {
  const key = `${row.provider}/${row.model}`
  const item = byModel.get(key) ?? { calls: 0, usageCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, pricedCalls: 0 }
  item.calls += 1
  if (row.usageAvailable) item.usageCalls += 1
  item.input += row.inputTokens
  item.output += row.outputTokens
  item.cacheRead += row.cacheReadTokens
  item.cacheWrite += row.cacheWriteTokens
  const rate = rates[key]
  if (row.usageAvailable && rate && [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].every((n) => Number.isFinite(n) && n >= 0)) {
    item.cost += (row.inputTokens * rate.input + row.outputTokens * rate.output + row.cacheReadTokens * rate.cacheRead + row.cacheWriteTokens * rate.cacheWrite) / 1_000_000
    item.pricedCalls += 1
  }
  byModel.set(key, item)

  const day = new Date(row.time).toISOString().slice(0, 10)
  byDay.set(day, (byDay.get(day) ?? 0) + row.totalTokens)
}

const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
console.log('\nDSH Token Monitor — local usage report')
console.log(`Calls recorded: ${rows.length}`)
console.log(`Total tokens:   ${rows.reduce((sum, row) => sum + row.totalTokens, 0).toLocaleString()}`)
console.log('\nBy model:')
if (byModel.size === 0) console.log('  No usage recorded yet.')
for (const [model, item] of byModel) {
  const cost = item.pricedCalls === item.calls
    ? `$${item.cost.toFixed(6)} estimated`
    : item.pricedCalls
      ? `$${item.cost.toFixed(6)} partial estimate`
      : 'price or usage unavailable'
  console.log(`  ${model}: ${item.calls} calls (${item.usageCalls} with usage) | in ${item.input.toLocaleString()} | out ${item.output.toLocaleString()} | cached ${(item.cacheRead + item.cacheWrite).toLocaleString()} | ${cost}`)
}
console.log('\nDaily token trend (bar length is relative):')
if (days.length === 0) console.log('  No history yet.')
const max = Math.max(1, ...days.map(([, tokens]) => tokens))
for (const [day, tokens] of days) {
  const bar = '█'.repeat(Math.max(1, Math.round(tokens / max * 28)))
  console.log(`  ${day}  ${bar} ${tokens.toLocaleString()}`)
}
console.log(`\nLedger: ${ledgerPath}`)
if (byModel.size && [...byModel.values()].some((item) => item.pricedCalls < item.calls)) {
  console.log(`Add per-model rates to ${ratesPath}; amounts are USD per 1 million tokens.`)
}
