// Prompts, schemas and response mapping, shared by the extension (importScripts) and the
// native host (bundled by bun). The HTTP providers run in the extension itself; the host
// only exists to spawn the Codex and Claude Code CLIs.

const AI_MAX_CUES = 900

const AI_DEFAULTS = {
  timeout: 600,
  anthropicUrl: 'https://api.anthropic.com',
  anthropicModel: 'claude-sonnet-5-5',
  anthropicGrammarModel: 'claude-haiku-5-5',
  wireModel: 'gpt-5.6-sol',
  wireGrammarModel: 'gpt-5.6-luna'
}

// Providers the extension calls over HTTP; everything else goes through the native host.
const AI_HTTP_SOURCES = ['anthropic', 'wire']

// Empty strings from the popup mean "use the default".
function aiSetting(config, key, fallback = AI_DEFAULTS[key]) {
  const value = config?.[key]
  return value === undefined || value === null || value === '' ? fallback : value
}

const LINES_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, t: { type: 'string' } },
        required: ['i', 't'],
        additionalProperties: false
      }
    }
  },
  required: ['lines'],
  additionalProperties: false
}

const SYNTAX_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          p: {
            type: 'array',
            items: {
              type: 'object',
              properties: { t: { type: 'string' }, r: { type: 'string' } },
              required: ['t', 'r'],
              additionalProperties: false
            }
          }
        },
        required: ['i', 'p'],
        additionalProperties: false
      }
    }
  },
  required: ['lines'],
  additionalProperties: false
}

function aiSystemPrompt(mode, sourceName, targetName) {
  if (mode === 'fixup') {
    return `You clean up automatically recognised ${sourceName} subtitles. `
      + 'The lines come from speech recognition without punctuation or capitalisation. '
      + 'Restore punctuation and capitalisation and fix obvious mishearings, '
      + 'such as wrongly split or confused words, using the neighbouring lines. '
      + 'Do not change the wording otherwise: do not translate, do not shorten. '
      + 'Keep the line split as it is: exactly one entry per input line, '
      + 'i is the number, t is the cleaned line.'
  }
  if (mode === 'syntax') {
    return `You parse ${sourceName} subtitle lines syntactically. `
      + 'For each numbered input line return one entry: i is the number, '
      + 'p is the line as a sequence of segments. '
      + 'The segments joined together must equal the input line exactly, '
      + 'with all spaces and punctuation, nothing left out and nothing added. '
      + 'Each segment gets a role r: '
      + 's = subject, v = finite verb, k = the rest of the verb group, that is an infinitive, '
      + 'participle or separated particle, o = object, '
      + 'a = adverbial of time, place, manner or reason, x = everything else. '
      + 'Group words that belong together into one segment; an article belongs to its noun.'
  }
  return `You translate the subtitles of a ${sourceName} series into ${targetName}. `
    + 'You get all lines of an episode at once, numbered. '
    + 'Translate each line on its own, but use the neighbouring lines as the context of the scene. '
    + 'Keep the register: colloquial stays colloquial, jargon stays jargon, '
    + 'insults are neither softened nor left out. '
    + 'No explanations, no notes. '
    + 'Return exactly one entry per input line: i is the line number, '
    + 't is the translation without the number.'
}

// Everything a backend needs for one request, independent of the backend.
function aiTask({ cues, mode = 'translate', sourceName = 'German', targetName = 'Russian' }) {
  if (!Array.isArray(cues) || !cues.length) throw new Error('empty track')
  if (cues.length > AI_MAX_CUES) throw new Error(`too many cues: ${cues.length}`)
  return {
    mode,
    count: cues.length,
    grammar: mode === 'fixup' || mode === 'syntax',
    system: aiSystemPrompt(mode, sourceName, targetName),
    schema: mode === 'syntax' ? SYNTAX_SCHEMA : LINES_SCHEMA,
    field: mode === 'syntax' ? 'p' : 't',
    prompt: cues.map((cue, k) => `${k + 1}. ${cue}`).join('\n')
  }
}

// Keyed by line number, not by position: a single spurious or missing entry then costs
// exactly itself instead of shifting every later line onto the wrong cue.
function aiMapLines(result, task, label) {
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result)
    } catch (err) {
      throw new Error(`${label} response did not parse as JSON`)
    }
  }
  if (!Array.isArray(result?.lines)) throw new Error(`${label} response did not parse as JSON`)
  let lines = result.lines.map(line => ({ ...line, i: Number(line?.i) || 0 }))
  if (!lines.some(line => line.i >= 1 && line.i <= task.count)) {
    lines = lines.map((line, k) => ({ ...line, i: k + 1 }))
  }
  const pairs = {}
  for (const line of lines) {
    if (line.i >= 1 && line.i <= task.count && line[task.field] != null) pairs[line.i] = line[task.field]
  }
  if (!Object.keys(pairs).length) throw new Error(`no usable lines out of ${task.count}`)
  return pairs
}

const aiSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// POST with retries on transient failures. Returns the parsed JSON body.
async function aiPostJson(label, url, body, headers, timeoutSeconds) {
  for (let attempt = 1; ; attempt++) {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutSeconds * 1000)
      })
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new Error(`${label}: no answer in ${timeoutSeconds}s`)
      throw new Error(`${label} endpoint unreachable: ${String(err?.message || err)}`)
    }
    const text = await res.text()
    if (res.ok) {
      try {
        return JSON.parse(text)
      } catch (err) {
        throw new Error(`${label} response did not parse as JSON`)
      }
    }
    if ([429, 500, 502, 503, 504, 529].includes(res.status) && attempt < 3) {
      await aiSleep(attempt * 5000)
      continue
    }
    let detail = ''
    try {
      detail = JSON.parse(text)?.error?.message || ''
    } catch (err) { /* not JSON */ }
    throw new Error(`${label} endpoint ${res.status}: ${(detail || text).slice(0, 200)}`)
  }
}

// Structured outputs: the answer is a text block holding schema-valid JSON. (Forced tool
// calls are rejected by the current Sonnet and Opus.)
async function aiAskAnthropic(task, config) {
  const key = aiSetting(config, 'anthropicKey', '')
  if (!key) throw new Error('anthropic: set the API key in the extension popup')
  const model = task.grammar ? aiSetting(config, 'anthropicGrammarModel') : aiSetting(config, 'anthropicModel')
  const base = String(aiSetting(config, 'anthropicUrl')).replace(/\/+$/, '')
  const response = await aiPostJson('anthropic', `${base}/v1/messages`, {
    model,
    max_tokens: 32000,
    system: task.system,
    messages: [{ role: 'user', content: task.prompt }],
    output_config: { format: { type: 'json_schema', schema: task.schema } }
  }, {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    // The request comes from an extension origin; the API wants this to be explicit.
    'anthropic-dangerous-direct-browser-access': 'true'
  }, Number(aiSetting(config, 'timeout')))
  if (response.stop_reason === 'refusal') throw new Error('anthropic: refused')
  if (response.stop_reason === 'max_tokens') throw new Error('anthropic: answer cut off at max_tokens')
  // Thinking blocks may come first; only the text carries the JSON.
  const text = (response.content || []).filter(block => block.type === 'text').map(block => block.text).join('')
  if (!text) throw new Error('anthropic response contained no output text')
  return aiMapLines(text, task, 'anthropic')
}

// A local Responses API proxy. Structured output is native there.
async function aiAskWire(task, config) {
  const gateway = String(aiSetting(config, 'wireGateway', '')).replace(/\/+$/, '')
  if (!gateway) throw new Error('wire: set the gateway address in the extension popup')
  const model = task.grammar ? aiSetting(config, 'wireGrammarModel') : aiSetting(config, 'wireModel')
  const response = await aiPostJson('wire', `${gateway}/responses`, {
    model,
    instructions: task.system,
    input: task.prompt,
    store: false,
    text: { format: { type: 'json_schema', name: 'lines', strict: true, schema: task.schema } }
  }, {}, Number(aiSetting(config, 'timeout')))
  if (response.status !== 'completed') throw new Error(`wire response was not completed: ${response.status || 'unknown'}`)
  const text = (response.output || [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content || [])
    .filter(part => part.type === 'output_text')
    .map(part => part.text)
    .join('')
  if (!text) throw new Error('wire response contained no output text')
  return aiMapLines(text, task, 'wire')
}

function aiAskHttp(source, request, config) {
  const task = aiTask(request)
  if (source === 'anthropic') return aiAskAnthropic(task, config)
  if (source === 'wire') return aiAskWire(task, config)
  return Promise.reject(new Error(`unknown LLM: ${source}`))
}

if (typeof module !== 'undefined') {
  module.exports = { AI_MAX_CUES, AI_DEFAULTS, AI_HTTP_SOURCES, aiSetting, aiTask, aiMapLines, aiAskHttp }
}
