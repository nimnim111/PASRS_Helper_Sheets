---
title: PASRS Helper — Privacy Policy
---

# PASRS Helper — Privacy Policy

_Last updated: 2026-06-29_

PASRS Helper is a browser extension for Pokémon Showdown that records your
battle replays and fills in **your own** PASRS Google Sheet with stats parsed
from those replays (your picks, leads, Terastallization, Elo, and opponent
match-ups).

This policy explains exactly what data the extension touches and where it goes.
The short version: **your data goes only from your browser to your own Google
Sheet. There is no PASRS Helper server, and we never receive, store, sell, or
share your data.**

## Who operates this extension

PASRS Helper is an open-source extension. The source code is publicly available
at the project's repository. There is no backend operated by the developer — the
extension runs entirely in your browser.

## What the extension accesses

### Pokémon Showdown data
- It reads your battle log on play.pokemonshowdown.com to detect when a game
  finishes, and it triggers Showdown's own "save replay" feature.
- It fetches the public replay JSON (`https://replay.pokemonshowdown.com/…json`)
  to parse the game (Pokémon used, moves, leads, Tera, Elo, result).
- If you choose a team to track, it reads that team from your local Showdown
  teambuilder.

### Google account data (only after you click "Sign in with Google")
The extension requests these scopes:

| Scope | Why it is needed |
|---|---|
| `https://www.googleapis.com/auth/drive.file` | To create **one** spreadsheet — your PASRS tracker — in your Google Drive. This scope only grants access to files the extension itself creates; it cannot see any of your other Drive files. |
| `https://www.googleapis.com/auth/spreadsheets` | To write the parsed game data into your PASRS tracker and read it back (e.g. to avoid duplicate rows). |

The extension uses these scopes solely to create and fill your PASRS tracker.
It does not read, modify, or collect any other files or data in your Google
account.

## Where your data goes

- Parsed game data and your team are written **directly from your browser to the
  Google Sheets / Google Drive APIs**, into a spreadsheet you own.
- Nothing is sent to any server operated by the extension developer. There is no
  analytics, tracking, advertising, or third-party data sharing.

## What is stored locally

The extension stores the following **in your browser only** (via the browser's
local extension storage):

- Your Google OAuth access token (so you don't have to sign in for every game).
- The ID of the spreadsheet it created/uses.
- Your extension settings (e.g. whether logging is enabled).

The OAuth token is held only in your browser. Signing out, or clearing the
extension's data, removes it. You can also revoke the extension's access at any
time at <https://myaccount.google.com/permissions>.

## Data retention and deletion

- The extension keeps no copy of your data outside your browser and your own
  Google Sheet.
- Removing the extension deletes its locally stored data.
- Your PASRS tracker spreadsheet is yours — delete it from Google Drive whenever
  you like.

## Children's privacy

The extension is not directed at children and collects no personal information.

## Changes to this policy

If this policy changes, the updated version will be published in the project
repository with a new "Last updated" date.

## Contact

For questions about this policy, open an issue on the project's GitHub
repository.
