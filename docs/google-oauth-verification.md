# Google OAuth Verification — PASRS Helper

This is everything Google's OAuth verification asks for, pre-written for this
extension. Verification is what lets **any** user sign in without the
"unverified app" warning and removes the 100-test-user cap.

PASRS Helper is a clean case: data flows only from the user's browser to the
user's own Google Sheet, with no third-party server.

## 0. Prerequisites (do these first)

1. **A domain you control** for the homepage + privacy policy. Easiest:
   **GitHub Pages** — enable Pages on the repo so `https://<you>.github.io/<repo>/`
   serves `PRIVACY.md`. Note your Pages domain (e.g. `nimnim111.github.io`).
2. **Verify that domain in Google Search Console**
   (<https://search.google.com/search-console>) with the **same** Google account
   that owns the Cloud project. Verification will reject authorized domains you
   haven't proven you own.
3. Make sure the two scopes are enabled and the APIs are on (Sheets API + Drive
   API).

## 1. OAuth consent screen fields

| Field | Value |
|---|---|
| App name | `PASRS Helper` |
| User support email | your email |
| App logo | `icons/icon-128.png` (120×120+ PNG, no rounded corners) |
| Application home page | your GitHub Pages URL (e.g. `https://nimnim111.github.io/Psars-Helper-Sheets/`) |
| Application privacy policy link | the hosted `PRIVACY.md` URL |
| Authorized domains | the domain from step 0 (e.g. `github.io`) |
| Developer contact email | your email |
| User type | External |

## 2. Scopes to request

Add exactly these (both are **sensitive**, not restricted — so no third-party
security assessment is required, just verification):

- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/spreadsheets`

## 3. Scope justifications (paste these)

**`.../auth/drive.file`**
> PASRS Helper creates a single Google Sheets spreadsheet — the user's "PASRS
> tracker" — in the user's own Google Drive. The drive.file scope is used only to
> create and access that one file the extension itself creates. The extension
> does not list, read, or modify any other files in the user's Drive. We chose
> drive.file specifically because it is the narrowest scope that allows the
> extension to create the tracker on the user's behalf, without access to the
> rest of their Drive.

**`.../auth/spreadsheets`**
> After the tracker is created, PASRS Helper writes data parsed from the user's
> own Pokémon Showdown battle replays (Pokémon used, leads, moves,
> Terastallization, Elo, result) into that spreadsheet, and reads it back to
> avoid writing duplicate rows. This scope is used solely to populate and read
> the user's own PASRS tracker. No spreadsheet data is sent anywhere other than
> between the user's browser and the Google Sheets API.

**How user data is handled (overall)**
> All processing happens locally in the user's browser. Replay data is fetched
> from the public Pokémon Showdown replay endpoint, parsed in the extension, and
> written directly to the user's own spreadsheet via the Google Sheets API. There
> is no PASRS Helper server; no user data is transmitted to, stored by, or shared
> with the developer or any third party. The OAuth token is stored only in the
> browser's local extension storage and can be revoked by the user at any time.

## 4. Demo video (required for sensitive scopes)

Record a short (1–3 min) screencast and upload it (unlisted YouTube is fine).
Show, in this order:

1. The OAuth consent screen — point out the **exact** scopes being granted, and
   that the client ID on the screen matches the one in `manifest.base.json`.
2. Clicking "Sign in with Google" in the extension and completing consent.
3. The extension creating the tracker (a new Google Sheet appears in Drive).
4. Playing/finishing a Showdown game and the row appearing in the sheet — i.e.
   the `drive.file` (create) and `spreadsheets` (write/read) scopes in actual use.
5. Briefly show that drive.file only touches the one created file.

Narrate that all data goes only to the user's own sheet.

## 5. Extension-specific notes

- The OAuth client is a single **Web application** client; the same client_id
  serves every install. Keep these redirect URIs registered:
  - Chrome (published): `https://<web-store-extension-id>.chromiumapp.org/`
  - Firefox (published): `https://<hash>.extensions.allizom.org/`
    (stable for the pinned `browser_specific_settings.gecko.id`)
- While unverified you may keep the app in **Testing** and add up to 100 **Test
  users** (they'll see the "unverified" warning). Submitting for verification is
  only needed for public release.
- Review timeline is typically a few days to a few weeks; Google may email
  follow-up questions — answer referencing the justifications above.

## 6. Submit

Cloud Console → OAuth consent screen → **Publish app** → **Prepare for
verification** → fill the fields from §1–§3, attach the demo video URL, submit.
