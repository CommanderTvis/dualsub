# Dualsub

A second subtitle line in your native language for videos in the language you are learning, plus optional grammar underlining of the subtitle line. Works on Prime Video, ARD Mediathek, ZDF, YouTube and Netflix, in any Chromium-based browser on macOS or Linux.

## Install

1. Download `dualsub-nightly.zip` from the [nightly release](https://github.com/CommanderTvis/dualsub/releases/tag/nightly) and unzip it.
2. Open the extensions page of your browser (Brave, Chrome, Chromium, Edge, Vivaldi, Arc), enable developer mode and choose "Load unpacked". Select the unzipped folder.
3. In a terminal, run `host/install.sh` from that folder, then restart the browser.

The AI translation needs `jq`, `curl` and `perl` (install `jq` with `brew install jq` or your distribution's package manager), plus whichever AI you pick below.

## Use

1. Open the Dualsub popup from the toolbar. Pick the language you are learning under "I am learning" and your native language under "Second line in".
2. Open a show and turn on subtitles in the language you are learning. Tracks in any other language are left alone.
3. Hold the right `Shift` key to show the second line while you watch.

Popup options:

- Hard mode hides the subtitles until you hold `Shift`.
- Grammar analysis underlines the parts of each subtitle line: subject, finite verb, rest of the verb, object, adverbial.

The second line comes from Google Translate at first and switches to the AI translation once the whole track is done, which takes a minute or two.

## Choose the AI

Pick the AI source in the popup. Its settings appear below; "default" and empty fields use the built-in defaults. Each source has two model dropdowns, one for translation and one for grammar: Opus, Sonnet or Haiku for Anthropic API and Claude Code; Luna, Terra, Sol or Astra for Codex and Wire.

- Anthropic API: paste your API key.
- Codex: install the Codex CLI and run `codex login`.
- Claude Code: install Claude Code and run `claude /login`.
- Wire: enter the address of a local Responses API gateway.

Settings, including the API key, stay in your browser on this machine.

## Update

Download the newest `dualsub-nightly.zip`, replace the folder contents, run `host/install.sh` again, and reload the extension.
