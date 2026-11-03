import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createRecord } from '../src/index.js'

const project = resolve(import.meta.dirname, '..')

function session(id = 's-1') {
  return { id, requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }) }
}

test('records a model call even when the provider supplies no token usage', () => {
  const record = createRecord(session(), {
    type: 'assistant/message', seq: 4, time: 1_800_000_000_000,
    data: { turn: 2, step: 1, message: { provider: 'deepseek', model: 'deepseek-chat' } },
  })
  assert.equal(record.usageAvailable, false)
  assert.equal(record.totalTokens, 0)
  assert.equal(record.provider, 'deepseek')
})

test('normalizes provider usage and reads usage from a failed attempt stream', () => {
  const completed = createRecord(session(), {
    type: 'assistant/message', seq: 4, time: 1_800_000_000_000,
    data: { turn: 2, step: 1, message: { provider: 'deepseek', model: 'deepseek-chat' }, usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, totalTokens: 999 } },
  })
  assert.deepEqual([completed.inputTokens, completed.outputTokens, completed.cacheReadTokens, completed.cacheWriteTokens, completed.totalTokens], [11, 7, 3, 0, 21])
  assert.equal(completed.usageAvailable, true)

  const failed = createRecord(session(), {
    type: 'assistant/attempt', seq: 5, time: 1_800_000_000_001,
    data: { turn: 2, step: 1, stream: [{ type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }] },
  })
  assert.equal(failed.attempt, true)
  assert.equal(failed.model, 'deepseek-chat')
  assert.equal(failed.totalTokens, 7)
})

test('ignores malformed usage without throwing and ignores unrelated session events', () => {
  const invalid = createRecord(session(), {
    type: 'assistant/message', seq: 8, time: 1_800_000_000_000,
    data: { turn: 1, step: 1, usage: { inputTokens: 'many', outputTokens: 2 } },
  })
  assert.equal(invalid.usageAvailable, false)
  assert.equal(invalid.totalTokens, 0)
  assert.equal(createRecord(session(), { type: 'tool/result', data: {} }), undefined)
})

test('plugin listener appends token metadata without copying prompt or response content', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-token-monitor-plugin-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const entry = new URL('../src/index.js', import.meta.url).href
  const script = `
    import { apply } from ${JSON.stringify(entry)};
    let listener;
    apply({ on(name, callback) { if (name !== 'session/event') throw Error('unexpected event'); listener = callback; } });
    listener({ id: 'session-1' }, {
      type: 'assistant/message', seq: 2, time: 1800000000000,
      data: { turn: 1, step: 1, message: { provider: 'deepseek', model: 'deepseek-chat', content: 'PRIVATE_PROMPT' }, usage: { inputTokens: 8, outputTokens: 3 } }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: project, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const ledger = await readFile(join(home, 'token-monitor', 'usage.jsonl'), 'utf8')
  assert.match(ledger, /"totalTokens":11/)
  assert.doesNotMatch(ledger, /PRIVATE_PROMPT/)
})

test('report and dashboard summarize calls, prices, dates, and safely render model labels', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-token-monitor-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const dataDir = join(home, 'token-monitor')
  await mkdir(dataDir, { recursive: true })
  const ledger = [
    { id: 'a', time: Date.parse('2026-10-01T12:00:00Z'), provider: 'deepseek', model: 'deepseek-chat', usageAvailable: true, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_100_000 },
    { id: 'b', time: Date.parse('2026-10-02T12:00:00Z'), provider: 'deepseek', model: '<svg onload=alert(1)>', usageAvailable: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
  ]
  await writeFile(join(dataDir, 'usage.jsonl'), `${ledger.map((row) => JSON.stringify(row)).join('\n')}\n`)
  await writeFile(join(dataDir, 'rates.json'), JSON.stringify({ models: {
    'deepseek/deepseek-chat': { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
  } }))

  const report = spawnSync(process.execPath, ['scripts/report.js'], { cwd: project, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  assert.equal(report.status, 0, report.stderr)
  assert.match(report.stdout, /Calls recorded: 2/)
  assert.match(report.stdout, /\$1\.200000 estimated/)
  assert.match(report.stdout, /2026-10-01/)
  assert.match(report.stdout, /2026-10-02/)

  const dashboard = spawnSync(process.execPath, ['scripts/dashboard.js'], { cwd: project, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  assert.equal(dashboard.status, 0, dashboard.stderr)
  const html = await readFile(join(dataDir, 'dashboard.html'), 'utf8')
  assert.match(html, /2026-10-01/)
  assert.match(html, /1,100,000/)
  assert.match(html, /价格\/用量待补齐/)
  assert.doesNotMatch(html, /<svg onload=alert\(1\)>/)
})
