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
PASRS Helper can append every recorded replay to a Google Sheet using OAuth and
the official Google Sheets API. Users sign in with their Google account from the
settings panel; replay data goes directly from the extension to Google's API
(no third party in between).

Each recorded replay appends a row: `[timestamp, format, p1, p2, result, url]`.

### How it's wired (for contributors)
The page-injected scripts cannot use `chrome.*`, and OAuth can only run in a
background context, so requests hop through three contexts:

```
page (React panel / showdown hook)
  --window.postMessage-->  content script (src/extension/index.ts)
  --chrome.runtime.sendMessage-->  background worker (src/background/index.ts)
  --> chrome.identity.getAuthToken --> Sheets API
```

- `src/lib/events.ts` — the page<->content RPC (`sheetsRequest` / `onSheetsRequest`).
- `src/background/index.ts` — OAuth + Sheets API calls (`auth`, `status`, `signout`, `log`).
- `src/components/ui/SheetsSettings.tsx` — sign-in UI + spreadsheet ID / sheet name.

### Developer setup: Google Cloud OAuth client (required)
The extension ships with a placeholder `client_id` in `manifest.base.json`. To
make sign-in work you must create your own OAuth client:

1. In the [Google Cloud Console](https://console.cloud.google.com), create a
   project and **enable the Google Sheets API** (APIs & Services → Library).
2. Configure the **OAuth consent screen** (External). Add the scope
   `https://www.googleapis.com/auth/spreadsheets`. While unverified you can add
   yourself as a test user.
3. Create an **OAuth client ID** of type **Chrome Extension**, using your
   unpacked extension's ID (from `chrome://extensions`). Note: the published
   Web Store ID differs from your local dev ID, so you'll typically need a
   separate client for production.
4. Replace `client_id` in `manifest.base.json` with the generated value and
   rebuild.

> Public distribution requires Google **app verification** for the sensitive
> Sheets scope (privacy policy, demo video, possibly a security assessment).
> Until verified, users see an "unverified app" warning and you're capped at
> ~100 test users.
>
#### Firefox
`chrome.identity.getAuthToken` is Chrome-only. On Firefox the background detects
this at runtime and uses `launchWebAuthFlow` (OAuth implicit flow) instead, so
you need a second OAuth client of type **Web application**:

1. Create a **Web application** OAuth client in the same Cloud project.
2. Add the extension's redirect URL — `chrome.identity.getRedirectURL()`, which
   on Firefox looks like `https://<id>.extensions.allizom.org/` — as an
   **Authorized redirect URI**. The `<id>` is stable because the build pins a
   `browser_specific_settings.gecko.id`.
3. Use that client's ID for Firefox builds (`oauth2.client_id` in
   `manifest.base.json`). The `build:firefox` target automatically converts the
   background to the `scripts` form Firefox MV3 expects.

### User setup
1. Open the target Google Sheet and copy its **spreadsheet ID** from the URL
   (`https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`).
2. In the PASRS Helper side panel → **Settings → Google Sheets**, enable
   **Log recorded replays to Google Sheets**.
3. Click **Sign in with Google** and grant access.
4. Paste the spreadsheet ID and, if your tab isn't named `Sheet1`, the sheet
   (tab) name.

From then on, each recorded replay appends a row to your sheet.

## Maintainers / Credits
The project is maintained by the following individuals:<br>
- [Blox](https://twitter.com/ItzMrBlox) · [Github](https://github.com/kasp470f)<br>
- [Alchemistake](https://twitter.com/alchemistake)<br> 
- [PokeBin Dev](https://twitter.com/PokeBinDev)<br>

and big thanks to [Showdex](https://github.com/doshidak/showdex) who provided the Room generation code.
