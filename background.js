importScripts('langs.js', 'ai.js')

// Content script reads the translated track straight from session storage,
// so the page context needs access to it.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })

const HOST = 'de.deutsch.prime_dualsub'

let target = DUALSUB_DEFAULT_LANG
// The language being learnt: the subtitle track is expected in it.
let source = DUALSUB_DEFAULT_SOURCE
let withSyntax = true
let aiSource = 'codex'
// Backend settings from the popup (paths, models, API key); the host applies its defaults.
let aiConfig = {}
let lastTrack = null
// Language of the last track when it is not German. Prime and Netflix hand over whatever
// track is selected, and paying the AI to translate an English show from "German" is waste.
let foreign = null

const language = () => DUALSUB_LANGS.find(item => item.code === target) || DUALSUB_LANGS[0]
const learnt = () => DUALSUB_LANGS.find(item => item.code === source) || { code: source, name: source }

chrome.storage.sync.get(['target', 'source', 'syntax', 'aiSource']).then(data => {
  if (data.target) target = data.target
  if (data.source) source = data.source
  if (typeof data.syntax === 'boolean') withSyntax = data.syntax
  if (data.aiSource) aiSource = data.aiSource
})

chrome.storage.local.get('aiConfig').then(data => { aiConfig = data.aiConfig || {} })

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.aiConfig) {
    aiConfig = changes.aiConfig.newValue || {}
    // A fixed key or model should rescue the Google-only lines without a page reload.
    if (lastTrack) ingestTrack(lastTrack)
  }
  if (area !== 'sync') return
  if (changes.syntax) {
    withSyntax = changes.syntax.newValue
    if (withSyntax && lastTrack && !foreign) parseSyntax(parseCues(lastTrack))
  }
  if (changes.aiSource) {
    aiSource = changes.aiSource.newValue || 'codex'
    cache.clear()
    persist()
    setStatus('idle')
    console.log('[dualsub] AI source switched to', aiSource)
    if (lastTrack) ingestTrack(lastTrack)
  }
  if (!changes.target && !changes.source) return
  if (changes.target) target = changes.target.newValue
  if (changes.source) source = changes.source.newValue || DUALSUB_DEFAULT_SOURCE
  cache.clear()
  persist()
  setStatus('idle')
  console.log('[dualsub] languages switched to', source, '->', target)
  if (lastTrack) ingestTrack(lastTrack)
})

// German line -> { t: translation, v: 'c' for AI or 'g' for Google }. The source is
// stored per line, not derived from the track status: a track can be half AI, half
// Google when a cue shows up that the bulk pass never saw.
const cache = new Map()
// German line -> [{ t, r }], the same line cut into syntactic roles.
const syntax = new Map()
// Raw recognised line -> cleaned German. Only auto-generated YouTube tracks land here.
const fixes = new Map()
const inFlight = new Map()

// Whitespace is dropped entirely rather than collapsed: the player joins the lines of a cue
// with a space, the subtitle file joins them with a line break, and neither is authoritative.
const normalize = text => text.replace(/\s+/g, '').toLowerCase()

// An MV3 service worker dies after ~30 seconds idle and takes the Map with it,
// so the translated track is mirrored into local storage (survives browser restart too).
let restored = null

// Bumped whenever the key format changes, so entries keyed the old way are dropped instead
// of sitting in the cache forever as guaranteed misses.
const CACHE_VERSION = 2

function restore() {
  if (!restored) {
    restored = chrome.storage.local.get(['cache', 'version']).then(data => {
      if (data.version !== CACHE_VERSION) {
        chrome.storage.local.set({ cache: {}, version: CACHE_VERSION })
        return
      }
      Object.entries(data.cache || {}).forEach(([key, value]) => {
        if (!cache.has(key)) cache.set(key, typeof value === 'string' ? { t: value, v: 'g' } : value)
      })
      Object.entries(data.syntax || {}).forEach(([key, value]) => {
        if (!syntax.has(key)) syntax.set(key, value)
      })
      Object.entries(data.fixes || {}).forEach(([key, value]) => {
        if (!fixes.has(key)) fixes.set(key, value)
      })
    })
  }
  return restored
}

function persist() {
  return chrome.storage.local.set({
    cache: Object.fromEntries(cache),
    syntax: Object.fromEntries(syntax),
    fixes: Object.fromEntries(fixes),
    version: CACHE_VERSION
  })
}

// idle | running | done | failed. Read by the in-player badge and by the popup.
function setStatus(state, detail) {
  return chrome.storage.session.set({ status: { state, detail: detail || '' } })
}

async function googleTranslate(text) {
  const url = 'https://translate.googleapis.com/translate_a/single'
    + `?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`google ${res.status}`)
  const body = await res.json()
  return body[0].map(chunk => chunk[0]).join('')
}

// The worker's console is invisible from the outside, so anything worth debugging goes to
// the host log as well.
function note(text) {
  console.warn('[dualsub]', text)
  try {
    const port = chrome.runtime.connectNative(HOST)
    port.onMessage.addListener(() => port.disconnect())
    // Read lastError so a missing host (HTTP providers need none) stays quiet.
    port.onDisconnect.addListener(() => void chrome.runtime.lastError)
    port.postMessage({ diag: text })
  } catch (err) { /* no host installed */ }
}

note(`worker v${chrome.runtime.getManifest().version} started`)
// A failure shown in the popup must not outlive the worker that produced it.
setStatus('idle')

let lastDiag = 0

// A miss reaching the worker means the page had nothing cached for that line. Ship the key
// and a sample of what is cached to the host log, where it can be read without the user
// copying console output by hand.
function reportMiss(text) {
  if (Date.now() - lastDiag < 15000) return
  lastDiag = Date.now()
  const sample = [...cache.keys()].slice(0, 3)
  const payload = JSON.stringify({ miss: normalize(text), size: cache.size, sample })
  try {
    const port = chrome.runtime.connectNative(HOST)
    port.onMessage.addListener(() => port.disconnect())
    port.onDisconnect.addListener(() => {})
    port.postMessage({ diag: payload })
  } catch (err) { /* no host, nothing to report to */ }
}

async function lookup(text) {
  if (foreign) throw new Error(`track is ${foreign}, not ${learnt().name}`)
  await restore()
  const key = normalize(text)
  if (cache.has(key)) return cache.get(key)
  if (inFlight.has(key)) return inFlight.get(key)
  const task = googleTranslate(text).then(out => {
    const entry = { t: out, v: 'g' }
    cache.set(key, entry)
    inFlight.delete(key)
    persist()
    return entry
  }, err => {
    inFlight.delete(key)
    throw err
  })
  inFlight.set(key, task)
  return task
}

// Both formats wrap the line in markup: TTML in <span>/<br>, WebVTT in <c.textWhite>.
function clean(text) {
  return text
    // Any break form, namespaced ones included: in TTML the break stands where a space
    // would be, so <tt:br/> stripped as a plain tag glues words together.
    .replace(/<\s*(?:[a-z0-9]+:)?br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    // Numeric entities: typographic quotes and dashes come through as &#8217; and such,
    // and a single undecoded one is enough to miss the cache key.
    .replace(/&#(\d+);/g, (all, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (all, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}

function parseCues(track) {
  // json3: what the YouTube player itself downloads.
  if (/^\s*\{/.test(track)) {
    try {
      return (JSON.parse(track).events || [])
        .map(event => clean((event.segs || []).map(seg => seg.utf8 || '').join('')))
        .filter(line => line && line !== '\n')
    } catch (err) {
      note(`json3 parse failed: ${String(err)}`)
      return []
    }
  }
  if (/^\s*WEBVTT/.test(track)) {
    return track.split(/\r?\n\r?\n/)
      .filter(block => block.includes('-->'))
      .map(block => {
        // A block may carry a cue number before the timing line, or none at all, so cut
        // everything up to and including the timing rather than a fixed number of lines.
        const lines = block.split(/\r?\n/)
        return clean(lines.slice(lines.findIndex(line => line.includes('-->')) + 1).join(' '))
      })
      .filter(Boolean)
  }
  // TTML/DFXP. DOMParser is unavailable in a service worker, so parse with a regex.
  return Array.from(track.matchAll(/<(?:\w+:)?p\b[^>]*>([\s\S]*?)<\/(?:\w+:)?p>/g))
    .map(match => clean(match[1]))
    .filter(Boolean)
}

let claudeBusy = Promise.resolve()

function askClaude(cues, mode, model) {
  const turn = claudeBusy.then(() => callAI(cues, mode, model))
  claudeBusy = turn.catch(() => {})
  return turn
}

// Neither the host nor the HTTP providers take more than 900 lines in one request.
const MAX_AI_CUES = AI_MAX_CUES

async function splitCues(cues, mode, model) {
  const mid = Math.ceil(cues.length / 2)
  const left = await askSplit(cues.slice(0, mid), mode, model).catch(() => ({}))
  const right = await askSplit(cues.slice(mid), mode, model).catch(() => ({}))
  const pairs = { ...left }
  Object.entries(right).forEach(([key, value]) => { pairs[String(Number(key) + mid)] = value })
  return pairs
}

// A refusal covers the whole batch even when one line triggers it. Halve and retry until
// the refused part is small enough to leave to Google (or, for roles, to skip).
async function askSplit(cues, mode, model) {
  if (cues.length > MAX_AI_CUES) {
    note(`track has ${cues.length} lines, splitting for host limit`)
    return splitCues(cues, mode, model)
  }
  try {
    return await askClaude(cues, mode, model)
  } catch (err) {
    if (!/refus/i.test(String(err)) || cues.length < 8) throw err
    note(`refused ${cues.length} lines, splitting`)
    return splitCues(cues, mode, model)
  }
}

// A pending fetch alone does not keep an MV3 worker alive for the minute or two a whole
// track takes; extension API calls do.
async function keepAlive(promise) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000)
  try {
    return await promise
  } finally {
    clearInterval(timer)
  }
}

function callAI(cues, mode, model) {
  const request = { cues, mode, model, aiSource, config: aiConfig, source, sourceName: learnt().name, target, targetName: language().name }
  // Anthropic API and Wire are plain HTTP: no native host involved.
  if (AI_HTTP_SOURCES.includes(aiSource)) return keepAlive(aiAskHttp(aiSource, request, aiConfig))
  return new Promise((resolve, reject) => {
    let port
    try {
      port = chrome.runtime.connectNative(HOST)
    } catch (err) {
      reject(err)
      return
    }
    const done = handler => (...args) => {
      port.disconnect()
      handler(...args)
    }
    port.onMessage.addListener(done(msg => {
      if (msg && msg.ok && msg.pairs) resolve(msg.pairs)
      else reject(new Error(msg?.error || 'bridge: unexpected response'))
    }))
    port.onDisconnect.addListener(() => {
      reject(new Error(chrome.runtime.lastError?.message || 'bridge: port closed'))
    })
    port.postMessage(request)
  })
}

// Prime ships subtitles in segments as playback goes, and a bulk pass takes a minute or
// two. Segments that arrive meanwhile go into a queue instead of being dropped, otherwise
// only the first one ever reaches Claude and the rest of the episode falls back to Google.
const queue = []
let draining = false

// ARD keeps the subtitle URL out of the page: it lives only in the page-gateway response,
// and the item id sits in the address bar. Both fetches happen here because the page itself
// is blocked by CORS.
async function loadArdTrack(id) {
  const api = `https://api.ardmediathek.de/page-gateway/pages/ard/item/${id}?embedded=false&mcV6=true`
  try {
    const res = await fetch(api)
    const meta = await res.text()
    const found = meta.split('\\/').join('/')
      .match(/https:\/\/api\.ardmediathek\.de\/player-service\/subtitle\/webvtt\/[^"'\s\\]+/)
    if (!found) {
      note(`ARD: gateway ${res.status}, ${meta.length} bytes, no subtitle url`)
      await setStatus('failed', 'this episode has no subtitle track')
      return
    }
    const track = await (await fetch(found[0])).text()
    note(`ARD: track ${track.length} bytes`)
    ingestTrack(track)
  } catch (err) {
    note(`ARD failed: ${String(err)}`)
    await setStatus('failed', String(err))
  }
}

async function ingestTrack(track, asr) {
  lastTrack = track
  const cues = parseCues(track)
  // Whole-track sample: a single cue is too short to detect reliably, a few hundred are not.
  const { languages } = await chrome.i18n.detectLanguage(cues.slice(0, 200).join(' '))
  const lang = languages[0]?.language
  foreign = lang && lang.split('-')[0] !== source ? lang : null
  note(`track received: ${track.length}b, ${cues.length} cues, asr=${!!asr}, lang=${lang}`)
  if (foreign) {
    await setStatus('foreign', foreign)
    return
  }
  queue.push({ track, asr })
  // A pass already in flight keeps this track waiting, and whoever queued it (a reload, a
  // switch of language or AI) may have reset the badge: say that work is still owed.
  if (draining) await setStatus('running', `${cues.length}`)
  drain()
}

// Speech recognition gives lowercase text without punctuation, which is hard to read and
// hard to parse. Clean it first, then everything downstream works on the cleaned line.
const FIX_BATCH = 60

async function fixupCues(raw) {
  const fixed = raw.slice()
  for (let start = 0; start < raw.length; start += FIX_BATCH) {
    const batch = raw.slice(start, start + FIX_BATCH)
    await setStatus('fixing', `${raw.length - start}`)
    try {
      const pairs = await askSplit(batch, 'fixup', 'sonnet')
      batch.forEach((line, i) => {
        const clean = pairs[String(i + 1)]
        if (typeof clean !== 'string' || !clean.trim()) return
        fixed[start + i] = clean
        fixes.set(normalize(line), clean)
      })
    } catch (err) {
      note(`fixup batch failed: ${String(err)}`)
    }
  }
  await persist()
  return fixed
}

async function drain() {
  if (draining) return
  draining = true
  try {
    while (queue.length) {
      await restore()
      const item = queue.shift()
      const raw = parseCues(item.track)
      const cues = item.asr ? await fixupCues(raw) : raw
      // A Google line is a placeholder, not a result: Claude still owes it.
      const fresh = cues.filter(cue => cache.get(normalize(cue))?.v !== 'c')
      if (!fresh.length) continue
      await setStatus('running', `${fresh.length}`)
      console.log(`[dualsub] segment: ${cues.length} cues, sending ${fresh.length} to AI`)
      const source = aiSource
      try {
        // Keyed by line number: a line Claude skipped just stays out of the cache and gets
        // picked up by Google later, instead of shifting every later cue onto a wrong line.
        const pairs = await askSplit(fresh, 'translate')
        if (source !== aiSource) continue
        let filled = 0
        fresh.forEach((cue, i) => {
          const line = pairs[String(i + 1)]
          if (typeof line !== 'string') return
          cache.set(normalize(cue), { t: line, v: 'c' })
          filled++
        })
        if (!filled) throw new Error('no lines mapped back onto the cues')
        await persist()
        await setStatus(queue.length ? 'running' : 'done', `${filled}`)
        console.log(`[dualsub] segment translated: ${filled}/${fresh.length} -> ${language().label}`)
        parseSyntax(cues)
      } catch (err) {
        if (source !== aiSource) continue
        await setStatus('failed', String(err.message || err))
        console.warn('[dualsub] AI unavailable, falling back to Google:', String(err))
      }
    }
  } finally {
    draining = false
  }
}

// Second pass, deliberately separate from the translation call: a failure here must not
// cost the translation, and the two prompts stay short and single-purpose.
// Chunked, unlike the translation pass: role segmentation emits several times more output
// per line, and one call over a whole episode outlives the service worker, which kills the
// native port mid-flight. Sonnet because the work is mechanical, not interpretive.
const SYNTAX_BATCH = 60

let pending = []
let syntaxRunning = false
let wanted = null

function parseSyntax(cues) {
  if (!withSyntax) {
    note('syntax off, skipping')
    return
  }
  const queued = new Set(pending.map(normalize))
  cues.forEach(cue => {
    const key = normalize(cue)
    if (!syntax.has(key) && !queued.has(key)) pending.push(cue)
  })
  runSyntax()
}

// The line on screen wins over file order: batches are cheap but slow, and the viewer is
// somewhere in the middle of the episode, not at cue one.
function takeBatch() {
  if (wanted) {
    const at = pending.findIndex(cue => normalize(cue) === wanted)
    wanted = null
    if (at >= 0) return pending.splice(Math.max(0, at - 5), SYNTAX_BATCH)
  }
  return pending.splice(0, SYNTAX_BATCH)
}

async function runSyntax() {
  if (syntaxRunning) return
  syntaxRunning = true
  // Bound call: an unbound API method throws when the timer fires, and the worker would
  // then be killed mid-pass exactly as before.
  const alive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000)
  try {
    while (pending.length && withSyntax) {
      const batch = takeBatch()
      note(`syntax batch of ${batch.length}, ${pending.length} left`)
      await setStatus('parsing', `${pending.length + batch.length}`)
      try {
        const pairs = await askSplit(batch, 'syntax', 'sonnet')
        let filled = 0
        batch.forEach((cue, i) => {
          const parts = pairs[String(i + 1)]
          if (!Array.isArray(parts) || !parts.length) return
          syntax.set(normalize(cue), parts)
          filled++
        })
        await persist()
        await setStatus(pending.length ? 'parsing' : 'done', `${pending.length}`)
        console.log(`[dualsub] syntax: +${filled}, ${pending.length} cues left`)
      } catch (err) {
        note(`syntax batch failed: ${String(err)}`)
        await setStatus('failed', `grammar: ${String(err)}`)
        break
      }
    }
  } finally {
    clearInterval(alive)
    syntaxRunning = false
  }
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === 'cache') {
    // The page tells which line it is missing roles for, so that batch jumps the queue.
    if (req.need) {
      wanted = req.need
      runSyntax()
    }
    // The page asks for the whole map instead of reading session storage directly:
    // storage access for untrusted contexts depends on setAccessLevel having run first,
    // and the content script can load before this worker ever started.
    restore().then(() => sendResponse({
      entries: Object.fromEntries(cache),
      syntax: Object.fromEntries(syntax),
      fixes: Object.fromEntries(fixes)
    }))
    return true
  }
  if (req.type === 'track') {
    ingestTrack(req.track, req.asr)
    return false
  }
  if (req.type === 'diag') {
    note(req.diag)
    return false
  }
  if (req.type === 'noTrack') {
    setStatus('failed', req.noTrack)
    return false
  }
  if (req.type === 'ardItem') {
    loadArdTrack(req.id)
    return false
  }
  if (req.type === 'trackUrl') {
    // ARD hands out a URL instead of a body: the page cannot read it cross-origin, the
    // worker can.
    fetch(req.trackUrl)
      .then(res => res.text())
      .then(ingestTrack)
      .catch(err => console.warn('[dualsub] track fetch failed:', String(err)))
    return false
  }
  if (req.type !== 'translate') return false
  reportMiss(req.text)
  lookup(req.text).then(
    entry => sendResponse({ text: entry.t, via: entry.v }),
    err => sendResponse({ error: String(err) })
  )
  return true
})
