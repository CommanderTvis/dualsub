// code goes to Google Translate and to subtitle track matching, name to the AI prompt and
// the popup, label is the language's own name.
const DUALSUB_LANGS = [
  { code: 'de', label: 'Deutsch', name: 'German' },
  { code: 'en', label: 'English', name: 'English' },
  { code: 'es', label: 'Español', name: 'Spanish' },
  { code: 'fr', label: 'Français', name: 'French' },
  { code: 'it', label: 'Italiano', name: 'Italian' },
  { code: 'ja', label: '日本語', name: 'Japanese' },
  { code: 'ko', label: '한국어', name: 'Korean' },
  { code: 'nl', label: 'Nederlands', name: 'Dutch' },
  { code: 'pl', label: 'Polski', name: 'Polish' },
  { code: 'pt', label: 'Português', name: 'Portuguese' },
  { code: 'ru', label: 'Русский', name: 'Russian' },
  { code: 'tr', label: 'Türkçe', name: 'Turkish' },
  { code: 'uk', label: 'Українська', name: 'Ukrainian' }
]

// Native language (the second line) and the language being learnt (the track).
const DUALSUB_DEFAULT_LANG = 'ru'
const DUALSUB_DEFAULT_SOURCE = 'de'

if (typeof module !== 'undefined') module.exports = { DUALSUB_LANGS, DUALSUB_DEFAULT_LANG, DUALSUB_DEFAULT_SOURCE }
