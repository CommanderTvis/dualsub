// code goes to Google Translate, de is the German name used in Claude's system prompt.
const DUALSUB_LANGS = [
  { code: 'ru', de: 'Russische', label: 'Русский', name: 'Russian' },
  { code: 'en', de: 'Englische', label: 'English', name: 'English' },
  { code: 'uk', de: 'Ukrainische', label: 'Українська', name: 'Ukrainian' },
  { code: 'pl', de: 'Polnische', label: 'Polski', name: 'Polish' },
  { code: 'es', de: 'Spanische', label: 'Español', name: 'Spanish' },
  { code: 'fr', de: 'Französische', label: 'Français', name: 'French' },
  { code: 'tr', de: 'Türkische', label: 'Türkçe', name: 'Turkish' }
]

const DUALSUB_DEFAULT_LANG = 'ru'

if (typeof module !== 'undefined') module.exports = { DUALSUB_LANGS, DUALSUB_DEFAULT_LANG }
