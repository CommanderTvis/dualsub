const select = document.getElementById('lang')
const status = document.getElementById('status')

DUALSUB_LANGS.forEach(lang => {
  const option = document.createElement('option')
  option.value = lang.code
  option.textContent = lang.label
  select.appendChild(option)
})

const syntax = document.getElementById('syntax')
const aiSource = document.getElementById('ai-source')
const hard = document.getElementById('hard')

chrome.storage.sync.get(['target', 'syntax', 'aiSource', 'hard']).then(data => {
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

aiSource.addEventListener('change', async () => {
  await chrome.storage.sync.set({ aiSource: aiSource.value })
  showConfig()
})

// Settings of the AI backends. They live in local storage, not sync: the API key must not
// leave this machine. Empty field = the bridge's default (shown as the placeholder).
const CONFIG = {
  codex: [['codexPath', 'Путь к codex', 'codex'],
    ['codexModel', 'Модель', 'из настроек Codex'],
    ['codexGrammarModel', 'Модель для грамматики', 'как основная']],
  claude: [['claudePath', 'Путь к claude', '~/.local/bin/claude']],
  anthropic: [['anthropicKey', 'API-ключ', 'sk-ant-…', 'password'],
    ['anthropicModel', 'Модель', 'claude-sonnet-5-5'],
    ['anthropicGrammarModel', 'Модель для грамматики', 'claude-haiku-5-5'],
    ['anthropicUrl', 'Адрес API', 'https://api.anthropic.com']],
  wire: [['wireGateway', 'Адрес шлюза', 'http://127.0.0.1:…/responses base'],
    ['wireModel', 'Модель', 'gpt-5.6-sol'],
    ['wireGrammarModel', 'Модель для грамматики', 'gpt-5.6-luna']]
}
const COMMON = [['timeout', 'Таймаут запроса, с', '600', 'number']]
const box = document.getElementById('ai-config')
let saved = {}

function showConfig() {
  box.replaceChildren()
  const fields = [...(CONFIG[aiSource.value] || []), ...COMMON]
  fields.forEach(([key, label, placeholder, type]) => {
    const wrap = document.createElement('label')
    wrap.className = 'field'
    wrap.textContent = label
    const input = document.createElement('input')
    input.type = type || 'text'
    input.placeholder = placeholder
    input.value = saved[key] ?? ''
    input.autocomplete = 'off'
    input.spellcheck = false
    input.addEventListener('change', () => {
      const value = input.value.trim()
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
    running: `Перевод дорожки: ${state.detail} реплик, минута-две.`,
    parsing: `Разбор грамматики: осталось ${state.detail} реплик.`,
    fixing: `Чистка автосубтитров: осталось ${state.detail} реплик.`,
    done: 'Дорожка переведена целиком.',
    foreign: `Дорожка на языке «${state.detail}», не немецкий — ИИ и Google не вызываются.`,
    failed: `ИИ недоступен, строка идёт из Google. ${state.detail}`,
    idle: 'Дорожка ещё не перехвачена — включи воспроизведение.'
  }[state.state] || ''
}

chrome.storage.session.get('status').then(data => paint(data.status || { state: 'idle' }))

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.status) paint(changes.status.newValue)
})

document.querySelector('h1').textContent += ` · v${chrome.runtime.getManifest().version}`
