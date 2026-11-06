import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function run({ mode = 'translate', env = {}, config = {}, behavior = 'ok', aiSource, cues = ['Hallo!', 'Welt'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dualsub-test-'))
  try {
    const bridge = join(dir, 'bridge.sh')
    const fake = join(dir, 'codex')
    const record = join(dir, 'record.json')
    copyFileSync(new URL('./bridge.sh', import.meta.url), bridge)
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = flag => args[args.indexOf(flag) + 1]
const schema = JSON.parse(fs.readFileSync(value('--output-schema'), 'utf8'))
const prompt = fs.readFileSync(0, 'utf8')
fs.writeFileSync(process.env.TEST_RECORD, JSON.stringify({ args, schema, prompt }))
console.log('CLI progress must not leak into the native frame')
if (process.env.TEST_BEHAVIOR === 'failure') process.exit(1)
if (process.env.TEST_BEHAVIOR === 'hang') return setInterval(() => {}, 1000)
if (process.env.TEST_BEHAVIOR === 'empty') process.exit(0)
const syntax = schema.properties.lines.items.properties.p
const lines = syntax ? [{ i: 1, p: [{ t: 'Hallo!', r: 'x' }] }]
  : [{ i: 2, t: 'Мир' }, { i: 1, t: 'Привет!' }]
fs.writeFileSync(value('--output-last-message'), process.env.TEST_BEHAVIOR === 'invalid'
  ? 'not json' : JSON.stringify({ lines }))
`, { mode: 0o755 })
    const body = Buffer.from(JSON.stringify({ cues, mode, model: 'sonnet', aiSource,
      config: { codexPath: fake, ...config } }))
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length)
    const childEnv = { ...process.env }
        const result = spawnSync('sh', [bridge], {
      env: { ...childEnv, DUALSUB_LOG: join(dir, 'log'),
        TEST_RECORD: record, TEST_BEHAVIOR: behavior, ...env },
      input: Buffer.concat([header, body]), timeout: 10000
    })
    assert.equal(result.status, 0, result.stderr?.toString())
    assert.equal(result.stdout.readUInt32LE(), result.stdout.length - 4)
    const response = JSON.parse(result.stdout.subarray(4))
    const invocation = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null
    if (invocation) {
      const args = invocation.args
      assert.equal(args[0], 'exec')
      assert.equal(args.at(-1), '-')
      assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
      assert.ok(args.includes('--ephemeral'))
      assert.ok(args.includes('--skip-git-repo-check'))
      assert.equal(existsSync(args[args.indexOf('--cd') + 1]), false, 'temporary files cleaned')
    }
    return { response, invocation }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('Codex is the default and maps translations by line number', () => {
  const { response, invocation } = run()
  assert.deepEqual(response.pairs, { 1: 'Привет!', 2: 'Мир' })
  assert.equal(response.ok, true)
  assert.equal(response.cost, null)
  assert.equal(typeof response.ms, 'number')
  assert.match(invocation.prompt, /1\. Hallo!\n2\. Welt/)
  assert.equal(invocation.args.includes('--model'), false, 'do not pass Claude model aliases')
})

test('the host rejects more than 900 cues before starting the model', () => {
  const { response, invocation } = run({ cues: Array(901).fill('Hallo!') })
  assert.deepEqual(response, { ok: false, error: 'too many cues: 901' })
  assert.equal(invocation, null)
})

test('syntax returns grammar spans with the grammar schema and model', () => {
  const { response, invocation } = run({ mode: 'syntax', config: { codexGrammarModel: 'grammar-model' } })
  assert.deepEqual(response.pairs, { 1: [{ t: 'Hallo!', r: 'x' }] })
  assert.match(invocation.prompt, /syntaktisch/)
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'grammar-model')
})

test('fixup uses the cleanup prompt and falls back to the Codex model setting', () => {
  const { response, invocation } = run({ mode: 'fixup', config: { codexModel: 'base-model' } })
  assert.equal(response.ok, true)
  assert.match(invocation.prompt, /Hoerfehler/)
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'base-model')
})

for (const behavior of ['failure', 'empty', 'invalid']) {
  test(`Codex ${behavior} produces a framed error for the Google fallback`, () => {
    const { response } = run({ behavior })
    assert.equal(response.ok, false)
    assert.match(response.error, /codex/)
  })
}

test('a Codex call that never answers is cut off with a framed error', () => {
  const { response } = run({ behavior: 'hang', config: { timeout: 1 } })
  assert.deepEqual(response, { ok: false, error: 'codex: no answer in 1s' })
})

test('request provider overrides the host default', () => {
  assert.deepEqual(run({ aiSource: 'unknown' }).response,
    { ok: false, error: 'unknown LLM: unknown' })
})

test('Anthropic API: forced tool call, key in header, results mapped by line number', async () => {
  const seen = {}
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      Object.assign(seen, { url: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], body: JSON.parse(raw) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ stop_reason: 'tool_use', content: [
        { type: 'text', text: 'ignored' },
        { type: 'tool_use', name: 'lines', input: { lines: [{ i: 2, t: 'Мир' }, { i: 1, t: 'Привет!' }] } }] }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const dir = mkdtempSync(join(tmpdir(), 'dualsub-test-'))
  try {
    const bridge = join(dir, 'bridge.sh')
    copyFileSync(new URL('./bridge.sh', import.meta.url), bridge)
    const body = Buffer.from(JSON.stringify({ cues: ['Hallo!', 'Welt'], mode: 'translate', aiSource: 'anthropic',
      config: { anthropicKey: 'sk-test', anthropicUrl: `http://127.0.0.1:${server.address().port}/` } }))
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length)
    const child = spawn('sh', [bridge], { env: { ...process.env, DUALSUB_LOG: join(dir, 'log') } })
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stdin.end(Buffer.concat([header, body]))
    await new Promise(resolve => child.on('close', resolve))
    const out = Buffer.concat(chunks)
    assert.deepEqual(JSON.parse(out.subarray(4)).pairs, { 1: 'Привет!', 2: 'Мир' })
    assert.equal(seen.url, '/v1/messages')
    assert.equal(seen.key, 'sk-test')
    assert.equal(seen.version, '2023-06-01')
    assert.equal(seen.body.model, 'claude-sonnet-5-5')
    assert.deepEqual(seen.body.tool_choice, { type: 'tool', name: 'lines' })
    assert.match(seen.body.messages[0].content, /1\. Hallo!\n2\. Welt/)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Anthropic API without a key fails before any request', () => {
  const { response } = run({ aiSource: 'anthropic' })
  assert.equal(response.ok, false)
  assert.match(response.error, /API key/)
})
