const select = document.getElementById('lang')
const source = document.getElementById('source')
const status = document.getElementById('status')

DUALSUB_LANGS.forEach(lang => {
  const text = lang.label === lang.name ? lang.name : `${lang.name} · ${lang.label}`
  select.add(new Option(text, lang.code))
  source.add(new Option(text, lang.code))
})

const syntax = document.getElementById('syntax')
const aiSource = document.getElementById('ai-source')
const hard = document.getElementById('hard')

chrome.storage.sync.get(['target', 'source', 'syntax', 'aiSource', 'hard']).then(data => {
  source.value = data.source || DUALSUB_DEFAULT_SOURCE
  hard.checked = data.hard === true
  select.value = data.target || DUALSUB_DEFAULT_LANG
  syntax.checked = data.syntax !== false
  aiSource.value = data.aiSource || 'codex'
  showConfig()
})

hard.addEventListener('change', () => {
  chrome.storage.sync.set({ hard: hard.checked })
})

syntax.addEventListener('change', () => {
  chrome.storage.sync.set({ syntax: syntax.checked })
})

select.addEventListener('change', async () => {
  await chrome.storage.sync.set({ target: select.value })
})

source.addEventListener('change', async () => {
  await chrome.storage.sync.set({ source: source.value })
})

aiSource.addEventListener('change', async () => {
  await chrome.storage.sync.set({ aiSource: aiSource.value })
  showConfig()
})

// Settings of the AI backends. They live in local storage, not sync: the API key must not
// leave this machine. Empty field = the bridge's default (shown as the placeholder).
const GPT = [['gpt-5.6-luna', 'Luna'], ['gpt-5.6-terra', 'Terra'], ['gpt-5.6-sol', 'Sol'], ['gpt-5.6-astra', 'Astra']]
const CLAUDE_MODELS = [['claude-opus-5-5', 'Opus'], ['claude-sonnet-5-5', 'Sonnet'], ['claude-haiku-5-5', 'Haiku']]
const CLI_MODELS = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]
// [key, label, placeholder, type, choices]: choices turn the field into a dropdown, the empty
// option meaning the default.
const CONFIG = {
  codex: [['codexPath', 'Path to codex', 'codex'],
    ['codexModel', 'Model', '', 'select', GPT],
    ['codexGrammarModel', 'Grammar model', '', 'select', GPT]],
  claude: [['claudePath', 'Path to claude', '~/.local/bin/claude'],
    ['claudeModel', 'Model', '', 'select', CLI_MODELS],
    ['claudeGrammarModel', 'Grammar model', '', 'select', CLI_MODELS]],
  anthropic: [['anthropicKey', 'API key', 'sk-ant-…', 'password'],
    ['anthropicModel', 'Model', '', 'select', CLAUDE_MODELS],
    ['anthropicGrammarModel', 'Grammar model', '', 'select', CLAUDE_MODELS],
    ['anthropicUrl', 'API URL', 'https://api.anthropic.com']],
  wire: [['wireGateway', 'Gateway URL', 'http://127.0.0.1:…/responses base'],
    ['wireModel', 'Model', '', 'select', GPT],
    ['wireGrammarModel', 'Grammar model', '', 'select', GPT]]
}
const COMMON = [['timeout', 'Request timeout, s', '600', 'number']]
const box = document.getElementById('ai-config')
let saved = {}

function showConfig() {
  box.replaceChildren()
  const fields = [...(CONFIG[aiSource.value] || []), ...COMMON]
  if (aiSource.value === 'codex' || aiSource.value === 'claude') {
    const hint = document.createElement('p')
    hint.textContent = 'Needs the native host: run host/dualsub-host install once.'
    box.appendChild(hint)
  }
  fields.forEach(([key, label, placeholder, type, choices]) => {
    const wrap = document.createElement('label')
    wrap.className = 'field'
    wrap.textContent = label
    let input
    if (choices) {
      input = document.createElement('select')
      const options = [['', 'default'], ...choices]
      // A model typed into an older version stays selectable.
      if (saved[key] && !choices.some(([value]) => value === saved[key])) options.push([saved[key], saved[key]])
      options.forEach(([value, text]) => input.add(new Option(text, value)))
    } else {
      input = document.createElement('input')
      input.type = type || 'text'
      input.placeholder = placeholder
      input.autocomplete = 'off'
      input.spellcheck = false
    }
    input.value = saved[key] ?? ''
    input.addEventListener('change', () => {
      const value = input.value.trim()
      // A custom API address needs its own host permission, asked while the user is here.
      if (value && (key === 'anthropicUrl' || key === 'wireGateway')) {
        try {
          chrome.permissions.request({ origins: [`${new URL(value).origin}/*`] }).catch(() => {})
        } catch (err) { /* not a URL; the request will fail with a clear error */ }
      }
      if (value) saved[key] = type === 'number' ? Number(value) : value
      else delete saved[key]
      chrome.storage.local.set({ aiConfig: saved })
    })
    wrap.appendChild(input)
    box.appendChild(wrap)
  })
}

chrome.storage.local.get('aiConfig').then(data => {
  saved = data.aiConfig || {}
  showConfig()
})

function paint(state) {
  status.textContent = {
    running: `Translating the track: ${state.detail} lines, a minute or two.`,
    parsing: `Grammar analysis: ${state.detail} lines left.`,
    fixing: `Cleaning up auto-generated subtitles: ${state.detail} lines left.`,
    done: 'The whole track is translated.',
    foreign: `The track is in "${state.detail}", not the language you are learning: no AI or Google calls.`,
    failed: `AI unavailable, lines come from Google. ${state.detail}`,
    idle: 'No subtitle track caught yet: start playback.'
  }[state.state] || ''
}

chrome.storage.session.get('status').then(data => paint(data.status || { state: 'idle' }))

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.status) paint(changes.status.newValue)
})

document.querySelector('h1').textContent += ` · v${chrome.runtime.getManifest().version}`
