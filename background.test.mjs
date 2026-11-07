import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInContext, runInNewContext } from 'node:vm'

test('tracks above the host limit keep every translation at its original line number', async () => {
  const calls = []
  const chrome = {
    runtime: {
      getManifest: () => ({ version: 'test' }),
      onMessage: { addListener() {} },
      connectNative: () => {
        let reply
        return {
          onMessage: { addListener(listener) { reply = listener } },
          onDisconnect: { addListener() {} },
          disconnect() {},
          postMessage(message) {
            if (message.diag) return
            calls.push(message.cues)
            const pairs = Object.fromEntries(message.cues.map((cue, i) => [i + 1, `Übersetzung ${cue}`]))
            queueMicrotask(() => reply({ ok: true, pairs }))
          }
        }
      }
    },
    storage: {
      session: { setAccessLevel() {}, set: async () => {} },
      sync: { get: async () => ({}) },
      local: { get: async () => ({}) },
      onChanged: { addListener() {} }
    }
  }
  const source = readFileSync(new URL('./background.js', import.meta.url), 'utf8')
  const context = {
    chrome,
    console,
    queueMicrotask,
    // The real shared scripts, loaded into the worker's global scope as importScripts would.
    importScripts(...files) {
      files.forEach(file => runInContext(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), context))
    }
  }
  const translate = runInNewContext(`${source}\naskSplit`, context)
  const cues = Array.from({ length: 901 }, (_, i) => `Zeile ${i + 1}`)

  const pairs = await translate(cues, 'translate')

  assert.deepEqual(calls.map(batch => batch.length), [451, 450])
  assert.equal(Object.keys(pairs).length, 901)
  assert.equal(pairs[1], 'Übersetzung Zeile 1')
  assert.equal(pairs[451], 'Übersetzung Zeile 451')
  assert.equal(pairs[452], 'Übersetzung Zeile 452')
  assert.equal(pairs[901], 'Übersetzung Zeile 901')
})
