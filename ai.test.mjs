import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const { aiAskHttp, aiMapLines, aiTask } = createRequire(import.meta.url)('./ai.js')

// A local stand-in for the provider: records the request and answers with `reply`.
async function serve(reply) {
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) })
      const { status = 200, body } = reply(seen.length)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

const request = { cues: ['Hallo!', 'Welt'], mode: 'translate', sourceName: 'German', targetName: 'Russian' }

test('Anthropic API: structured output, key in header, results mapped by line number', async () => {
  const api = await serve(() => ({ body: { stop_reason: 'end_turn', content: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: JSON.stringify({ lines: [{ i: 2, t: 'Мир' }, { i: 1, t: 'Привет!' }] }) }] } }))
  try {
    const pairs = await aiAskHttp('anthropic', request, { anthropicKey: 'sk-test', anthropicUrl: `${api.url}/` })
    assert.deepEqual(pairs, { 1: 'Привет!', 2: 'Мир' })
    const [{ url, headers, body }] = api.seen
    assert.equal(url, '/v1/messages')
    assert.equal(headers['x-api-key'], 'sk-test')
    assert.equal(headers['anthropic-version'], '2023-06-01')
    assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true')
    assert.equal(body.model, 'claude-sonnet-5-5')
    assert.equal(body.tool_choice, undefined, 'current models reject forced tool use')
    assert.equal(body.output_config.format.type, 'json_schema')
    assert.equal(body.output_config.format.schema.additionalProperties, false)
    assert.match(body.system, /German series into Russian/)
    assert.match(body.messages[0].content, /1\. Hallo!\n2\. Welt/)
  } finally {
    api.close()
  }
})

test('Anthropic API: grammar passes use the grammar model', async () => {
  const api = await serve(() => ({ body: { content: [{ type: 'text', text: JSON.stringify({ lines: [{ i: 1, p: [{ t: 'Hallo!', r: 'x' }] }] }) }] } }))
  try {
    await aiAskHttp('anthropic', { ...request, mode: 'syntax' }, { anthropicKey: 'k', anthropicUrl: api.url, anthropicGrammarModel: 'claude-opus-5-5' })
    assert.equal(api.seen[0].body.model, 'claude-opus-5-5')
    assert.ok(api.seen[0].body.output_config.format.schema.properties.lines.items.properties.p)
  } finally {
    api.close()
  }
})

test('Anthropic API: a refusal says so, which makes the extension split the batch', async () => {
  const api = await serve(() => ({ body: { stop_reason: 'refusal', content: [] } }))
  try {
    await assert.rejects(aiAskHttp('anthropic', request, { anthropicKey: 'k', anthropicUrl: api.url }), /refus/)
  } finally {
    api.close()
  }
})

test('Anthropic API: an error status carries the API message', async () => {
  const api = await serve(() => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } }))
  try {
    await assert.rejects(aiAskHttp('anthropic', request, { anthropicKey: 'k', anthropicUrl: api.url }),
      { message: 'anthropic endpoint 401: invalid x-api-key' })
  } finally {
    api.close()
  }
})

test('Anthropic API without a key fails before any request', async () => {
  await assert.rejects(aiAskHttp('anthropic', request, {}), /API key/)
})

test('Wire: Responses API with a strict JSON schema', async () => {
  const api = await serve(() => ({ body: { status: 'completed', output: [{ type: 'message', content: [
    { type: 'output_text', text: JSON.stringify({ lines: [{ i: 1, t: 'Привет!' }, { i: 2, t: 'Мир' }] }) }] }] } }))
  try {
    const pairs = await aiAskHttp('wire', request, { wireGateway: `${api.url}/v1/` })
    assert.deepEqual(pairs, { 1: 'Привет!', 2: 'Мир' })
    assert.equal(api.seen[0].url, '/v1/responses')
    assert.equal(api.seen[0].body.model, 'gpt-5.6-sol')
    assert.equal(api.seen[0].body.text.format.strict, true)
  } finally {
    api.close()
  }
})

test('Wire without a gateway fails before any request', async () => {
  await assert.rejects(aiAskHttp('wire', request, {}), /gateway/)
})

test('lines without usable numbers fall back to their position', () => {
  const task = aiTask(request)
  assert.deepEqual(aiMapLines({ lines: [{ i: 0, t: 'a' }, { i: 99, t: 'b' }] }, task, 'x'), { 1: 'a', 2: 'b' })
  assert.throws(() => aiMapLines('not json', task, 'x'), /did not parse/)
})
