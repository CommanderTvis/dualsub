import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// DUALSUB_HOST points at a compiled binary; by default the source runs under bun.
const HOST = process.env.DUALSUB_HOST
  ? [process.env.DUALSUB_HOST]
  : ['bun', fileURLToPath(new URL('./host.js', import.meta.url))]

function frame(message) {
  const body = Buffer.from(JSON.stringify(message))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}

function host(dir, input, env = {}, args = ['chrome-extension://test/']) {
  const result = spawnSync(HOST[0], [...HOST.slice(1), ...args], {
    env: { ...process.env, DUALSUB_LOG: join(dir, 'log'), ...env },
    input, timeout: 15000
  })
  assert.equal(result.status, 0, result.stderr?.toString())
  return result
}

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = flag => args[args.indexOf(flag) + 1]
const schema = JSON.parse(fs.readFileSync(value('--output-schema'), 'utf8'))
const prompt = fs.readFileSync(0, 'utf8')
fs.writeFileSync(process.env.TEST_RECORD, JSON.stringify({ args, schema, prompt, cwd: process.cwd() }))
console.log('CLI progress must not leak into the native frame')
if (process.env.TEST_BEHAVIOR === 'failure') process.exit(1)
if (process.env.TEST_BEHAVIOR === 'hang') return setInterval(() => {}, 1000)
if (process.env.TEST_BEHAVIOR === 'empty') process.exit(0)
const syntax = schema.properties.lines.items.properties.p
const lines = syntax ? [{ i: 1, p: [{ t: 'Hallo!', r: 'x' }] }]
  : [{ i: 2, t: 'Мир' }, { i: 1, t: 'Привет!' }]
fs.writeFileSync(value('--output-last-message'), process.env.TEST_BEHAVIOR === 'invalid'
  ? 'not json' : JSON.stringify({ lines }))
`

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.writeFileSync(process.env.TEST_RECORD, JSON.stringify({ args, prompt: fs.readFileSync(0, 'utf8'), thinking: process.env.MAX_THINKING_TOKENS }))
console.log(JSON.stringify({ is_error: false, result: JSON.stringify({ lines: [{ i: 1, t: 'Привет!' }] }) }))
`

function run({ mode = 'translate', config = {}, behavior = 'ok', aiSource, cues = ['Hallo!', 'Welt'], extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dualsub-test-'))
  try {
    const record = join(dir, 'record.json')
    for (const [name, body] of [['codex', FAKE_CODEX], ['claude', FAKE_CLAUDE]]) {
      writeFileSync(join(dir, name), body, { mode: 0o755 })
    }
    const request = { cues, mode, model: 'sonnet', aiSource, ...extra,
      config: { codexPath: join(dir, 'codex'), claudePath: join(dir, 'claude'), ...config } }
    const result = host(dir, frame(request), { TEST_RECORD: record, TEST_BEHAVIOR: behavior })
    assert.equal(result.stdout.readUInt32LE(), result.stdout.length - 4)
    const response = JSON.parse(result.stdout.subarray(4))
    const invocation = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null
    if (invocation && (aiSource || 'codex') === 'codex') {
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
  assert.equal(typeof response.ms, 'number')
  assert.match(invocation.prompt, /1\. Hallo!\n2\. Welt/)
  assert.match(invocation.prompt, /German series into Russian/)
  assert.equal(invocation.args.includes('--model'), false, 'do not pass Claude model aliases')
})

test('languages from the request reach the prompt', () => {
  const { invocation } = run({ extra: { sourceName: 'Spanish', targetName: 'English' } })
  assert.match(invocation.prompt, /Spanish series into English/)
})

test('the host rejects more than 900 cues before starting the model', () => {
  const { response, invocation } = run({ cues: Array(901).fill('Hallo!') })
  assert.deepEqual(response, { ok: false, error: 'too many cues: 901' })
  assert.equal(invocation, null)
})

test('syntax returns grammar spans with the grammar schema and model', () => {
  const { response, invocation } = run({ mode: 'syntax', config: { codexGrammarModel: 'grammar-model' } })
  assert.deepEqual(response.pairs, { 1: [{ t: 'Hallo!', r: 'x' }] })
  assert.match(invocation.prompt, /parse German subtitle lines syntactically/)
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'grammar-model')
})

test('fixup uses the cleanup prompt and falls back to the Codex model setting', () => {
  const { response, invocation } = run({ mode: 'fixup', config: { codexModel: 'base-model' } })
  assert.equal(response.ok, true)
  assert.match(invocation.prompt, /mishearings/)
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

test('Claude Code: model by mode, no thinking for grammar, result mapped', () => {
  const translate = run({ aiSource: 'claude' })
  assert.deepEqual(translate.response.pairs, { 1: 'Привет!' })
  assert.equal(translate.invocation.args[translate.invocation.args.indexOf('--model') + 1], 'opus')
  assert.equal(translate.invocation.thinking, undefined)
  const grammar = run({ aiSource: 'claude', mode: 'syntax', config: { claudeGrammarModel: 'haiku' } })
  assert.equal(grammar.invocation.args[grammar.invocation.args.indexOf('--model') + 1], 'haiku')
  assert.equal(grammar.invocation.thinking, '0')
})

test('HTTP providers are not served by the host', () => {
  assert.deepEqual(run({ aiSource: 'anthropic' }).response, { ok: false, error: 'unknown LLM: anthropic' })
})

test('diagnostics are logged and acknowledged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dualsub-test-'))
  try {
    const result = host(dir, frame({ diag: 'hello' }))
    assert.deepEqual(JSON.parse(result.stdout.subarray(4)), { ok: true })
    assert.match(readFileSync(join(dir, 'log'), 'utf8'), /diag: hello/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('install registers the binary with every browser present', { skip: !process.env.DUALSUB_HOST && 'needs the compiled binary' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dualsub-test-'))
  try {
    const config = process.platform === 'darwin' ? join(dir, 'Library', 'Application Support') : join(dir, '.config')
    const browser = process.platform === 'darwin' ? 'Google/Chrome' : 'google-chrome'
    mkdirSync(join(config, browser), { recursive: true })
    host(dir, '', { HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') }, ['install'])
    const manifest = JSON.parse(readFileSync(join(config, browser, 'NativeMessagingHosts', 'de.deutsch.prime_dualsub.json'), 'utf8'))
    assert.match(manifest.path, /dualsub-host$/)
    assert.deepEqual(manifest.allowed_origins, ['chrome-extension://ehhcbkjmmppglbijpafhmimehhiibnag/'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
