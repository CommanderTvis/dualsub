// MAIN world: Prime fetches the subtitle track as a single file before playback starts.
// Match it by content rather than URL — Amazon rotates URLs and CDNs, not the format.
(() => {
  const seen = new Set()

  function looksLikeSubtitles(text) {
    if (!text || text.length < 64 || text.length > 4e6) return false
    // Tags may carry a namespace prefix (<tt:tt>, <tt:p>), Netflix does exactly that.
    if (/^\s*(<\?xml|<(?:\w+:)?tt[\s>]|WEBVTT)/.test(text)) return /<(?:\w+:)?(?:tt|p)[\s>]|-->/.test(text)
    // YouTube's own player asks for json3, and its subtitle URL only answers when the
    // player builds it — fetching the one from the page response returns an empty 200.
    return /^\s*\{/.test(text) && text.includes('"events"')
  }

  function offer(text, url = '') {
    if (!looksLikeSubtitles(text)) return
    const key = text.length + ':' + text.slice(0, 64)
    if (seen.has(key)) return
    seen.add(key)
    window.postMessage({ source: 'dualsub-inject', diag: `track offered: ${text.length}b ${JSON.stringify(text.slice(0, 60))}` }, '*')
    window.postMessage({
      source: 'dualsub-inject',
      track: text,
      asr: /[?&]kind=asr/.test(url)
    }, '*')
  }

  // YouTube lists its subtitle tracks in the player response and serves them from its own
  // origin, so the page fetches the track itself — no interception, no CORS.
  let lastVideo = null
  // Language being learnt, sent by the content script; no track is picked before it arrives.
  let learn = null
  addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'dualsub-content') return
    if (!event.data.learn || event.data.learn === learn) return
    learn = event.data.learn
    lastVideo = null
    findYoutubeTrack()
  })

  const say = text => window.postMessage({ source: 'dualsub-inject', diag: `YT: ${text}` }, '*')

  async function findYoutubeTrack() {
    if (!location.hostname.endsWith('youtube.com')) return
    const video = new URLSearchParams(location.search).get('v')
    if (!video || video === lastVideo || !learn) return

    const response = window.ytInitialPlayerResponse
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (!tracks?.length) {
      if (!reported) { reported = true; say(`no captionTracks, playerResponse=${!!response}`) }
      return
    }
    if (response?.videoDetails?.videoId !== video) {
      if (!reported) { reported = true; say(`playerResponse is for ${response?.videoDetails?.videoId}, page is ${video}`) }
      return
    }
    reported = false
    say(`tracks ${tracks.map(t => `${t.languageCode}/${t.kind || 'manual'}`).join(' ')}`)

    const matching = tracks.filter(track => (track.languageCode || '').split('-')[0] === learn)
    // A real subtitle track always beats speech recognition.
    const picked = matching.find(track => track.kind !== 'asr') || matching.find(track => track.kind === 'asr')
    if (!picked) {
      lastVideo = video
      window.postMessage({ source: 'dualsub-inject', noTrack: `no ${learn} subtitles` }, '*')
      return
    }

    lastVideo = video
    const url = `${picked.baseUrl}${picked.baseUrl.includes('?') ? '&' : '?'}fmt=vtt`
    try {
      const res = await fetch(url)
      const track = await res.text()
      say(`picked ${picked.languageCode}/${picked.kind || 'manual'}, ${res.status}, ${track.length} bytes`)
      // An empty body is the normal answer here; the player's own request is caught above.
      if (track.length > 64) {
        window.postMessage({ source: 'dualsub-inject', track, asr: picked.kind === 'asr' }, '*')
      }
    } catch (err) {
      say(`fetch failed: ${String(err)}`)
    }
  }

  let reported = false

  if (location.hostname.endsWith('youtube.com')) {
    setInterval(findYoutubeTrack, 2000)
    findYoutubeTrack()
  }

  const originalFetch = window.fetch
  window.fetch = function (...args) {
    return originalFetch.apply(this, args).then(res => {
      res.clone().text().then(text => offer(text, res.url), () => {})
      return res
    })
  }

  const originalSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        // Netflix asks for its subtitle files as arraybuffer; decode those, skip real media.
        if (this.responseType === 'arraybuffer') {
          const bytes = this.response
          // Peek before decoding: most arraybuffer responses on a video site are media.
          const head = bytes && bytes.byteLength < 4e6
            ? new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength)))
            : ''
          if (/^\s*(<\?xml|WEBVTT|<tt)/.test(head)) offer(new TextDecoder().decode(bytes), this.responseURL)
        } else if (typeof this.responseText === 'string') {
          offer(this.responseText, this.responseURL)
        }
      } catch (err) { /* responseType is neither text nor a buffer */ }
    })
    return originalSend.apply(this, args)
  }
})()
