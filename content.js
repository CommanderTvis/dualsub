// Prime paints each line as its own node; ARD nests them deep inside one box, so take the
// leaves of whichever container this site uses.
const CAPTION = location.hostname.endsWith('ardmediathek.de')
  // Scoped to the overlay: the subtitle *button* carries the same class as the caption box.
  ? '.ardplayer-viewport-addon-overlays .ardplayer-untertitel'
  : location.hostname.endsWith('youtube.com')
    ? '.ytp-caption-segment'
    : location.hostname.endsWith('netflix.com')
      ? '.player-timedtext-text-container'
      : location.hostname.endsWith('zdf.de')
        ? '.zdfplayer-cue'
        : '[class*="atvwebplayersdk-captions-text"]'
const MARK = 'dualsub-line'
const HIDDEN = 'dualsub-hidden'
const HOTKEY = 'ShiftRight'
const DEBUG = true

// The whole episode lives here, so a hit costs a Map lookup and renders in the same
// mutation callback as the German line. The worker round-trip is only for misses.
const translated = new Map()
let lastSource = null
let lastEntry = null
let lastBottom = null
let lastProbe = 0
let candidate = null
let candidateAt = 0
let pending = 0
let revealed = false
let observer = null

// Must match the worker's key exactly: whitespace dropped, not collapsed.
const normalize = text => text.replace(/\s+/g, '').toLowerCase()

const parsed = new Map()
const fixes = new Map()

// An auto-generated track is shown by the player as recognised: lowercase, no punctuation.
// Swap in the cleaned line so the viewer reads proper German, and so everything downstream
// keys off the same text.
function applyFixes(nodes) {
  if (!fixes.size || !nodes.length) return
  if (nodes.some(node => node.dataset.dualsubFixed)) return
  const clean = fixes.get(normalize(nodes.map(node => node.textContent).join(' ')))
  if (!clean) return
  nodes.forEach((node, i) => {
    node.textContent = i ? '' : clean
    node.dataset.dualsubFixed = '1'
  })
}
let withSyntax = true

// Hard mode: no caption at all, German included, until the hotkey is held. The player's own
// text is only made transparent, never removed, so layout and the cue lookup keep working.
const hardStyle = document.createElement('style')
hardStyle.textContent = `html.dualsub-hard:not(.dualsub-peek) ${CAPTION} { opacity: 0 !important }`
document.documentElement.appendChild(hardStyle)

const setHard = on => document.documentElement.classList.toggle('dualsub-hard', !!on)

chrome.storage.sync.get(['syntax', 'hard']).then(data => {
  withSyntax = data.syntax !== false
  setHard(data.hard)
}, () => {})

// The page-world script picks the YouTube track by language, and only this side can read
// the setting.
const tellLearnt = code => window.postMessage({ source: 'dualsub-content', learn: code || 'de' }, '*')
chrome.storage.sync.get('source').then(data => tellLearnt(data.source), () => tellLearnt())

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return
  if (changes.syntax) withSyntax = changes.syntax.newValue
  if (changes.hard) setHard(changes.hard.newValue)
  if (changes.source) tellLearnt(changes.source.newValue)
})

// Roles come back for the whole cue, but the player may have split that cue across nodes at
// a different point than the subtitle file did. So walk the cue character by character,
// skipping whitespace on both sides, and hand each node the slice that is actually its own.
function rolesForNodes(parts, texts) {
  const queue = []
  parts.forEach(part => {
    for (const ch of part.t) if (!/\s/.test(ch)) queue.push({ ch, r: part.r })
  })

  let cursor = 0
  let previous = 'x'
  const perNode = []
  for (const text of texts) {
    const runs = []
    for (const ch of text) {
      let role
      if (/\s/.test(ch)) {
        role = previous
      } else {
        const next = queue[cursor]
        if (!next || next.ch !== ch) return null
        role = next.r
        previous = role
        cursor++
      }
      const last = runs[runs.length - 1]
      if (last && last.r === role) last.t += ch
      else runs.push({ t: ch, r: role })
    }
    perNode.push(runs)
  }
  return cursor === queue.length ? perNode : null
}

function annotate(nodes) {
  if (!withSyntax || !nodes.length) return
  // Cheapest possible check first: this runs on every mutation of a busy player.
  if (nodes.every(node => node.dataset.dualsubParsed)) return
  const texts = nodes.map(node => node.textContent)
  const parts = parsed.get(normalize(texts.join(' ')))
  if (!parts) {
    // The syntax pass finishes long after the page pulled its copy, and it produces no
    // translation misses to piggyback on, so ask again when a line has no roles yet.
    if (Date.now() - lastPull > 5000) pullCache(normalize(texts.join(' ')))
    return
  }
  const perNode = rolesForNodes(parts, texts)
  if (!perNode) {
    if (DEBUG) console.log('[dualsub] roles did not line up with', JSON.stringify(texts))
    return
  }
  nodes.forEach((node, i) => {
    if (node.dataset.dualsubParsed) return
    const textNodes = Array.from(node.childNodes).filter(child => child.nodeType === Node.TEXT_NODE)
    // Runs were computed over textContent; that only maps back onto a single text node.
    if (textNodes.length !== 1) return
    const fragment = document.createDocumentFragment()
    perNode[i].forEach(run => {
      const span = document.createElement('span')
      span.className = `dualsub-role dualsub-${run.r}`
      span.textContent = run.t
      fragment.appendChild(span)
    })
    node.replaceChild(fragment, textNodes[0])
    node.dataset.dualsubParsed = '1'
  })
}

function absorb(entries) {
  translated.clear()
  Object.entries(entries || {}).forEach(([key, value]) => {
    translated.set(key, typeof value === 'string' ? { t: value, v: 'g' } : value)
  })
}

let lastPull = 0

if (location.hostname.endsWith('ardmediathek.de')) {
  let lastItem = null
  const watchItem = () => {
    const id = location.pathname.split('/').filter(Boolean).pop()
    if (!id || id === lastItem || !/^[A-Za-z0-9_-]{16,}$/.test(id)) return
    lastItem = id
    try {
      chrome.runtime.sendMessage({ type: 'ardItem', id })
    } catch (err) { /* dead context */ }
  }
  watchItem()
  // The site is a SPA: switching episodes changes the address without a reload.
  setInterval(() => {
    watchItem()
    if (lastStatus) showStatus(lastStatus)
  }, 3000)
}

function pullCache(need) {
  lastPull = Date.now()
  try {
    chrome.runtime.sendMessage({ type: 'cache', need }, res => {
      if (chrome.runtime.lastError || !res) return
      absorb(res.entries)
      parsed.clear()
      Object.entries(res.syntax || {}).forEach(([key, value]) => parsed.set(key, value))
      fixes.clear()
      Object.entries(res.fixes || {}).forEach(([key, value]) => fixes.set(key, value))
      if (DEBUG) {
        console.log('[dualsub] cache pulled:', translated.size,
          'sample:', JSON.stringify([...translated.keys()].slice(0, 3)))
      }
    })
  } catch (err) { /* dead context, the observer already gave up */ }
}

pullCache()

chrome.storage.session.get('status').then(data => showStatus(data.status), () => {})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.aiSource) {
    translated.clear()
    lastSource = null
    lastEntry = null
    pending++
    clearLine()
    schedule()
  }
  if (area === 'session') {
    if (changes.cache) {
      absorb(changes.cache.newValue)
      lastSource = null
      schedule()
    }
    if (changes.status) showStatus(changes.status.newValue)
  }
})

// Fullscreen renders only the subtree of the fullscreen element, so both the line and this
// badge have to live inside it rather than on the body.
function statusHost() {
  return document.fullscreenElement
    || document.querySelector('.ardplayer, .zdfplayer, [class*="atvwebplayersdk"], [class*="webPlayer"], .watch-video')
    || document.body
}

let lastStatus = null

function showStatus(status) {
  lastStatus = status
  const host = statusHost()
  const existing = document.querySelector('.dualsub-status')
  const text = {
    running: `Translating the track: ${status?.detail} lines…`,
    fixing: `Cleaning up auto-generated subtitles: ${status?.detail} left…`,
    parsing: `Grammar analysis: ${status?.detail} left…`,
    foreign: `Track is not in the language you are learning (${status?.detail}), translation off`,
    failed: `AI unavailable (${status?.detail || 'unknown reason'}), lines come from Google`,
    done: 'Track translated'
  }[status?.state]
  if (!text) {
    if (existing) existing.remove()
    return
  }
  const badge = existing || document.createElement('div')
  badge.className = 'dualsub-status'
  // Falling back to the body means the player is not mounted yet; its rect is the whole
  // page, so anchoring to it drops the badge somewhere below the video.
  if (host === document.body) {
    badge.style.left = '24px'
    badge.style.top = `${innerHeight - 72}px`
  } else {
    const hostBox = host.getBoundingClientRect()
    badge.style.left = `${hostBox.left + 24}px`
    badge.style.top = `${hostBox.bottom - 56}px`
  }
  badge.textContent = text
  if (badge.parentElement !== host) host.appendChild(badge)
  clearTimeout(badge.timer)
  if (status.state !== 'running') {
    badge.timer = setTimeout(() => badge.remove(), 6000)
  }
}

const IS_ARD = location.hostname.endsWith('ardmediathek.de')
const IS_YT = location.hostname.endsWith('youtube.com')
const IS_ZDF = location.hostname.endsWith('zdf.de')

// ARD leaves its captions where the control bar appears, so the bar cuts through the text
// while the controls are up. Lift the text nodes themselves rather than their container:
// that container is the size of the whole player, and moving it moves everything inside.
function liftCaptions(nodes) {
  if (!IS_ARD) return
  const player = document.querySelector('.ardplayer')
  const shift = player && player.classList.contains('ardplayer-show-controls')
    ? 'translateY(-2.6em)'
    : ''
  nodes.forEach(node => {
    if (node.style.transform !== shift) node.style.transform = shift
  })
}

// Elements that carry text of their own, not leaves: Netflix puts the second line of a cue
// as a bare text node next to a <br>, inside a span that therefore is not a leaf.
const ownText = node => Array.from(node.childNodes)
  .some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())

function captionNodes() {
  const nodes = []
  document.querySelectorAll(CAPTION).forEach(root => {
    if (ownText(root)) nodes.push(root)
    root.querySelectorAll('*').forEach(node => { if (ownText(node)) nodes.push(node) })
  })
  return nodes.filter(node => !node.classList.contains(MARK))
}

// Own layer instead of a clone inside the player's caption box: ARD positions every line
// of a cue separately, so touching that container tears the cue apart. The layer sits in the
// fullscreen element when there is one, otherwise in the player, so it survives fullscreen.
function overlayHost(node) {
  if (document.fullscreenElement) return document.fullscreenElement
  return node.closest('.ardplayer, .zdfplayer, [class*="atvwebplayersdk"], [class*="webPlayer"], .watch-video') || document.body
}

function clearLine() {
  document.querySelectorAll(`.${MARK}`).forEach(line => line.remove())
}

function render(nodes, text, via) {
  const anchor = nodes[0]
  if (!anchor) return
  const host = overlayHost(anchor)
  const hostBox = host.getBoundingClientRect()
  const boxes = nodes.map(node => node.getBoundingClientRect())
  const bottom = Math.max(...boxes.map(box => box.bottom))

  let line = host.querySelector(`.${MARK}`)
  if (!line) {
    clearLine()
    line = document.createElement('div')
    line.className = MARK
    host.appendChild(line)
  }

  line.classList.toggle(HIDDEN, !revealed)
  line.classList.toggle('dualsub-google', via === 'g')
  line.style.fontSize = getComputedStyle(anchor).fontSize
  // Viewport coordinates, so the player's own containers stay untouched: giving one of them
  // `position: relative` re-anchors the player's absolutely positioned parts and pushes its
  // captions down into the control bar.
  line.style.left = `${hostBox.left + hostBox.width * 0.05}px`
  line.style.width = `${hostBox.width * 0.9}px`

  line.textContent = ''
  const mark = document.createElement('span')
  mark.className = 'dualsub-mark'
  // Real spacing character, not only a margin: the marker sat flush against the first word
  // and read as part of it.
  mark.textContent = `${via === 'c' ? 'AI' : 'G'}\u2009`
  line.appendChild(mark)
  // The cue may come back with a line break inside; flatten it and let the layer wrap.
  line.appendChild(document.createTextNode(text.replace(/\s*\n\s*/g, ' ')))

  // Height is only known once the text is in, and a long line wraps: ARD puts its captions
  // close to the bottom edge, where anything below the cue would be cut off by the player.
  const height = line.offsetHeight
  const below = bottom + 6
  const above = Math.min(...boxes.map(box => box.top)) - height - 6
  // ZDF's control bar overlays the video instead of pushing the cue region up, and slides
  // off-screen when idle, so its measured top is the real floor in both states.
  const bar = IS_ZDF && host.querySelector('[class*="bottom-controls"]')
  const floor = bar ? Math.min(hostBox.bottom, bar.getBoundingClientRect().top) : hostBox.bottom
  const fits = below + height <= floor - 4
  line.style.top = `${fits ? below : Math.max(hostBox.top + 4, above)}px`
  lastBottom = Math.round(bottom)
  lastEntry = { t: text, v: via }
  setTimeout(schedule, 120)
  setTimeout(schedule, 500)

  if (DEBUG) console.log('[dualsub]', via, JSON.stringify(text))
}

function currentText(nodes) {
  return nodes.map(node => node.textContent.trim()).filter(Boolean).join(' ')
}

// Amazon paints every line of a cue as its own node, and TTML often keeps them as separate
// <p> elements too. So the joined text may be absent from the cache while both halves are
// there: look up the whole thing first, then line by line.
function fromCache(nodes, joined) {
  const whole = translated.get(normalize(joined))
  if (whole) return whole

  const parts = nodes
    .map(node => node.textContent.trim())
    .filter(Boolean)
    .map(text => translated.get(normalize(text)))
  if (parts.length && parts.every(Boolean)) {
    return { t: parts.map(part => part.t).join(' '), v: parts[0].v }
  }
  return undefined
}

function tick() {
  const nodes = captionNodes()
  liftCaptions(nodes)
  applyFixes(nodes)
  annotate(nodes)
  const text = currentText(nodes)
  if (!text) {
    lastSource = null
    clearLine()
    return
  }
  // YouTube reveals a caption word by word. Without waiting for it to settle, every
  // intermediate state would be looked up, and misses would each cost a Google request.
  if (IS_YT) {
    if (text !== candidate) {
      candidate = text
      candidateAt = Date.now()
      setTimeout(schedule, 400)
      return
    }
    if (Date.now() - candidateAt < 350) {
      setTimeout(schedule, 200)
      return
    }
  }

  if (text === lastSource) {
    // The caption block moves when the player shows or hides its controls; follow it, but
    // read layout a few times a second at most — this runs on every frame with mutations.
    if (!lastEntry || Date.now() - lastProbe < 150) return
    lastProbe = Date.now()
    const bottom = Math.max(...nodes.map(node => node.getBoundingClientRect().bottom))
    if (Math.round(bottom) !== lastBottom) render(nodes, lastEntry.t, lastEntry.v)
    return
  }
  lastSource = text

  const hit = fromCache(nodes, text)
  if (hit !== undefined) {
    render(nodes, hit.t, hit.v)
    pending++
    return
  }

  if (DEBUG) {
    const keys = nodes.map(node => normalize(node.textContent.trim()))
    console.log('[dualsub] miss', JSON.stringify(keys), 'cached:', translated.size)
  }
  // A miss may simply mean the page copy is stale: the worker could have finished a
  // segment while this tab was not listening.
  if (Date.now() - lastPull > 5000) pullCache()

  const requestId = ++pending
  try {
    chrome.runtime.sendMessage({ type: 'translate', text }, res => {
      if (requestId !== pending) return
      if (chrome.runtime.lastError || !res || res.error) {
        console.warn('[dualsub]', chrome.runtime.lastError?.message || res?.error)
        clearLine()
        return
      }
      render(captionNodes(), res.text, res.via)
    })
  } catch (err) {
    // The extension was reloaded and this tab is stuck on a dead context.
    // Everything past this point is console spam, so shut up until the page reloads.
    observer.disconnect()
    console.warn('[dualsub] context died, reload the tab:', String(err))
  }
}

addEventListener('message', event => {
  if (event.source !== window) return
  if (event.data?.source !== 'dualsub-inject') return
  try {
    const { track, trackUrl, asr, noTrack, diag } = event.data
    if (diag) chrome.runtime.sendMessage({ type: 'diag', diag })
    else if (noTrack) chrome.runtime.sendMessage({ type: 'noTrack', noTrack })
    else if (trackUrl) chrome.runtime.sendMessage({ type: 'trackUrl', trackUrl })
    else chrome.runtime.sendMessage({ type: 'track', track, asr })
  } catch (err) {
    console.warn('[dualsub] track did not reach the worker:', String(err))
  }
})

function setRevealed(state) {
  if (state === revealed) return
  revealed = state
  document.documentElement.classList.toggle('dualsub-peek', state)
  document.querySelectorAll(`.${MARK}`).forEach(line => {
    line.classList.toggle(HIDDEN, !revealed)
  })
}

addEventListener('keydown', e => { if (e.code === HOTKEY) setRevealed(true) }, true)
addEventListener('keyup', e => { if (e.code === HOTKEY) setRevealed(false) }, true)
addEventListener('blur', () => setRevealed(false))

// Entering or leaving fullscreen swaps the element both layers must live in.
addEventListener('fullscreenchange', () => {
  clearLine()
  lastSource = null
  if (lastStatus) showStatus(lastStatus)
})

// The player mutates the DOM many times a second, and tick reads layout, which forces a
// synchronous reflow. Coalesce to one run per frame or the main thread stalls.
let scheduled = false

function schedule() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    tick()
  })
}

function start() {
  observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  })
  console.log(`[dualsub] v${chrome.runtime.getManifest().version} active, caption nodes:`, captionNodes().length)
}

if (document.body) start()
else addEventListener('DOMContentLoaded', start)
