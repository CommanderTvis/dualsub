# Dualsub

A second subtitle line for German video, in your language, plus optional grammar underlining of the German line. Works on Prime Video, ARD Mediathek, ZDF, YouTube and Netflix.

## Install

1. Download `dualsub-nightly.zip` from the [nightly release](https://github.com/CommanderTvis/dualsub/releases/tag/nightly) and unzip it.
2. Open the extensions page of a Chromium-based browser (Brave, Chrome, Edge, Vivaldi, Arc), enable developer mode and choose "Load unpacked". Select the unzipped folder.
3. In a terminal, run `host/install.sh` from that folder, then restart the browser.

The translation backend needs `jq`, `curl` and `perl` on your Mac (`brew install jq` if `jq` is missing), plus whichever AI you pick below.

## Use

1. Open a German show and turn on German subtitles in the player. Shows without a German subtitle track are skipped.
2. Open the Dualsub popup from the toolbar and pick your language.
3. Hold the right `Shift` key to show the second line in your language while you watch.

Popup options:

- Hard mode hides the German subtitles until you hold `Shift`.
- German line analysis underlines the parts of each German line: subject, finite verb, rest of the verb bracket, object, adverbial.

The translation is first taken from Google and replaced by the AI version once the whole track is translated, which takes a minute or two.

## Choose the AI

Pick the source in the popup. Settings appear below it; empty fields use the defaults.

- Anthropic API: paste your API key. Defaults to Claude Sonnet for translation and Claude Haiku for the grammar passes.
- Codex: install the Codex CLI and run `codex login`.
- Claude: install Claude Code and run `claude /login`.
- Wire: enter the address of a local Responses API gateway.

Settings are saved in your browser on this machine only, including the API key.

## Update

Download the newest `dualsub-nightly.zip`, replace the folder contents, run `host/install.sh` again if the host changed, and reload the extension.
