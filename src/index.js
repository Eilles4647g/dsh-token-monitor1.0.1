import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-token-monitor'

const defaultHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const ledgerPath = join(defaultHome, 'token-monitor', 'usage.jsonl')
const ratesPath = join(defaultHome, 'token-monitor', 'rates.json')
let writeQueue = Promise.resolve()

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const inputTokens = validCount(usage.inputTokens)
  const outputTokens = validCount(usage.outputTokens)
  const cacheReadTokens = usage.cacheReadTokens === undefined ? 0 : validCount(usage.cacheReadTokens)
  const cacheWriteTokens = usage.cacheWriteTokens === undefined ? 0 : validCount(usage.cacheWriteTokens)
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].some(value => value === undefined)) return undefined
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  if (!Number.isSafeInteger(totalTokens)) return undefined
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
}

function lastUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'usage' && record.usage) return record.usage
  }
  return undefined
}

function routeFromHeader(header) {
  const config = header?.config ?? {}
  if (typeof config.provider !== 'string' && typeof config.model !== 'string') return undefined
  return { provider: config.provider, model: config.model }
}

function getRoute(data, session, lastRoute) {
  const message = data?.message ?? {}
  const header = session?.requestHeader?.()?.config ?? {}
  return {
    provider: typeof message.provider === 'string'
      ? message.provider
      : (lastRoute?.provider ?? (typeof header.provider === 'string' ? header.provider : 'unknown')),
    model: typeof message.model === 'string'
      ? message.model
      : (lastRoute?.model ?? (typeof header.model === 'string' ? header.model : 'unknown')),
  }
}

export function createRecord(session, event, lastRoute) {
  const data = event.data ?? {}
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const usage = normalizeUsage(data.usage ?? lastUsage(data.stream))
  const { provider, model } = getRoute(data, session, lastRoute)
  const inputTokens = usage?.inputTokens ?? 0
  const outputTokens = usage?.outputTokens ?? 0
  const cacheReadTokens = usage?.cacheReadTokens ?? 0
  const cacheWriteTokens = usage?.cacheWriteTokens ?? 0

  return {
    id: `${session.id ?? 'session'}:${event.seq}`,
    time: event.time,
    sessionId: String(session.id ?? 'unknown'),
    turn: data.turn,
    step: data.step,
    attempt: event.type === 'assistant/attempt',
    provider,
    model,
    usageAvailable: usage !== undefined,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: usage?.totalTokens ?? 0,
  }
}

export function apply(ctx) {
  const routes = new WeakMap()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'request/header') {
      const route = routeFromHeader(event.data?.header)
      if (route) routes.set(session, route)
      return
    }
    const record = createRecord(session, event, routes.get(session))
    if (!record) return

    // Persist usage metadata only. Prompt text, responses, tool arguments and API keys
    // are intentionally never copied into the monitor ledger.
    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(ledgerPath), { recursive: true })
      await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8')
    }).catch(error => {
      console.error(`[${name}] could not write usage ledger:`, error)
    })
  })

  console.info(`[${name}] recording token metadata at ${ledgerPath}`)
  console.info(`[${name}] optional model rates: ${ratesPath}`)
}
