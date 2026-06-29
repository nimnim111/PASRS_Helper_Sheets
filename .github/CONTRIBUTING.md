# Contributing to PASRS Helper
Thank you for your interest in contributing to PASRS Helper! We welcome contributions from the community to help improve the project. 

Please follow the guidelines below to ensure a smooth contribution process.

## How to Contribute
1. **Fork the Repository**: Start by forking the PASRS Helper repository to your own GitHub account.
2. **Create a New Branch**: Create a new branch for your feature or bug fix.
3. **Make Changes**: Make your changes in the new branch.
4. **Create a Pull Request**: Open a pull request from your branch to the main repository's main branch.
5. **Describe Your Changes**: Provide a clear description of the changes you made and why they are necessary.


## Google Sheets Integration
PASRS Helper logs every recorded battle into the **PASRS 4.3** tracking
spreadsheet using OAuth and the official Google Sheets API. Users sign in with
their Google account from the settings panel; data goes directly from the
extension to Google's API (no third party in between).

It appends a row to the template's **`GBG Data`** sheet (the raw-input sheet the
template's dashboards are computed from). Per battle it fills: Game number,
Result, opponent name, the opponent's revealed six species, your four picks
(leads + backs), their four picks, both sides' Tera Pokémon + type, OTS, your
Elo (`before -> after`) and the opponent's Elo. Picks come from switch-in order,
Tera from `|-terastallize|`, OTS from the battle rules, and Elo from rated games
only.

### How it's wired (for contributors)
The page-injected scripts cannot use `chrome.*`, and OAuth can only run in a
background context, so requests hop through three contexts:

```
page (React panel / showdown hook)
  --window.postMessage-->  content script (src/extension/index.ts)
  --chrome.runtime.sendMessage-->  background worker (src/background/index.ts)
  --> chrome.identity.launchWebAuthFlow --> Sheets API
```

- `src/lib/events.ts` — the page<->content RPC (`sheetsRequest` / `onSheetsRequest`).
- `src/utils/showdown-battle-utils.ts` — parses players, opponent species, switches, Tera, OTS, and rating changes from the protocol.
- `src/lib/showdown/showdown.ts` — accumulates battle details and builds the GBG Data row payload (`buildGbgPayload`).
- `src/background/index.ts` — OAuth + Sheets API calls (`auth`, `status`, `signout`, `log`); appends to `GBG Data`.
- `src/components/ui/SheetsSettings.tsx` — sign-in UI + spreadsheet ID.

Auth uses `chrome.identity.launchWebAuthFlow` (the OAuth popup) on **every**
browser — Chrome, Chromium forks (Brave, Edge, …) and Firefox. We deliberately
do **not** use `chrome.identity.getAuthToken`: it only works reliably in Google
Chrome and needs a different client type. One web flow means one OAuth client
and one code path.

### Developer setup: Google Cloud OAuth client (required)
The extension ships with a placeholder `client_id` in `manifest.base.json`. To
make sign-in work you must create your own OAuth client:

1. In the [Google Cloud Console](https://console.cloud.google.com), create a
   project and **enable the Google Sheets API** (APIs & Services → Library).
2. Configure the **OAuth consent screen** (External). Add the scope
   `https://www.googleapis.com/auth/spreadsheets`. While unverified, add yourself
   under **Test users**.
3. Create an **OAuth client ID** of type **Web application** (the same single
   client works for all browsers).
4. Add the extension's redirect URL(s) under **Authorized redirect URIs**. The
   value comes from `chrome.identity.getRedirectURL()` and differs per browser —
   load the unpacked build and read it from the background console:
   - Chromium: `https://<extension-id>.chromiumapp.org/`
   - Firefox: `https://<id>.extensions.allizom.org/` (stable because the build
     pins `browser_specific_settings.gecko.id`)

   Add one entry per browser you'll run.
5. Replace `client_id` in `manifest.base.json` with the generated value, then
   `npm run build:chrome` (or `build:firefox`). The Firefox build automatically
   converts the background to the `scripts` form Firefox MV3 expects.

> Public distribution requires Google **app verification** for the sensitive
> Sheets scope (privacy policy, demo video, possibly a security assessment).
> Until verified, users see an "unverified app" warning and you're capped at
> ~100 test users.

### User setup
1. Make a copy of the **PASRS 4.3** spreadsheet in your own Google Drive (File →
   Make a copy, or upload the `.xlsx` and open it as a Google Sheet). It must
   contain the `GBG Data` sheet.
2. Copy its **spreadsheet ID** from the URL
   (`https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`).
3. In the PASRS Helper side panel → **Settings → Google Sheets**, enable
   **Log recorded replays to Google Sheets**, click **Sign in with Google**, and
   paste the spreadsheet ID.

From then on, each recorded battle appends a row to the `GBG Data` sheet and the
template's dashboards update automatically.

## Maintainers / Credits
The project is maintained by the following individuals:<br>
- [Blox](https://twitter.com/ItzMrBlox) · [Github](https://github.com/kasp470f)<br>
- [Alchemistake](https://twitter.com/alchemistake)<br> 
- [PokeBin Dev](https://twitter.com/PokeBinDev)<br>

and big thanks to [Showdex](https://github.com/doshidak/showdex) who provided the Room generation code.
