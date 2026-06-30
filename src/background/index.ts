import type {
	SheetsAction,
	SheetsRequestData,
	SheetsResponse,
} from '../lib/events';
import { replayJsonUrl, replayToData } from '../lib/sheets/replay-to-data';
import { teamFromPaste } from '../lib/sheets/team-from-paste';

// Background service worker: the only context that may use chrome.identity and
// hold an OAuth token. It signs the user in, then for each recorded replay it
// fetches + parses the battle and writes the parsed data into the PASRS
// template's source sheets (`Base Data`, `Team Info From Paste`). This
// reproduces the template's own custom functions (REPLAYTODATA /
// TEAMDATAFROMPASTE), which are lost when the sheet is exported as xlsx, so the
// template's plain formula-driven dashboards render identically — no Apps Script.
//
// Messages arrive from the content script (which relays them from the page).

interface BackgroundMessage {
	action: SheetsAction;
	data?: SheetsRequestData;
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
// Drive multipart upload endpoint, used to create the tracker from the bundled
// xlsx template (converted to a Google Sheet on upload).
const DRIVE_UPLOAD =
	'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
const TEMPLATE_FILE = 'pasrs-template.xlsx';
const NEW_SHEET_NAME = 'PASRS Tracker';
const TOKEN_STORAGE_KEY = 'pasrs_sheets_token';
const SPREADSHEET_STORAGE_KEY = 'pasrs_sheets_spreadsheet_id';
// Spreadsheets whose custom-function cells we've already neutralised.
const PREPARED_STORAGE_KEY = 'pasrs_sheets_prepared';

// PASRS HomePage layout: replay links go in C14:C113, the Showdown name in G6,
// the team pokepaste URL in G8.
const HOMEPAGE = 'HomePage';
const REPLAY_RANGE = 'C14:C113';
const REPLAY_FIRST_ROW = 14;
const REPLAY_MAX = 100;
const NAME_CELL = 'G6';
const PASTE_CELL = 'G8';

// `Base Data` holds one "spill" row per game (REPLAYTODATA's output) that every
// downstream formula reads. Row 3 pairs with HomePage replay-link row 14, and so
// on. The spill occupies columns B..CT; helper formulas live in CU onward and
// must not be overwritten, so each game row is written across exactly B..CT.
const BASE_DATA = 'Base Data';
const BASE_DATA_FIRST_ROW = 3;
const BASE_DATA_LAST_SPILL_COL = 'CT';
const BASE_DATA_SPILL_WIDTH = 97; // columns B..CT inclusive

// `Team Info From Paste` holds the player's team (TEAMDATAFROMPASTE's output)
// down column A, starting A1.
const TEAM_INFO = 'Team Info From Paste';

// ---------------------------------------------------------------------------
// Auth (launchWebAuthFlow on every browser — one Web-application OAuth client)
// ---------------------------------------------------------------------------

function getOAuthConfig(): { clientId: string; scopes: string[] } {
	const oauth2 = (
		chrome.runtime.getManifest() as chrome.runtime.Manifest & {
			oauth2?: { client_id: string; scopes: string[] };
		}
	).oauth2;
	return {
		clientId: oauth2?.client_id ?? '',
		// Updated to use non-sensitive drive.file scope so custom domains are not required
		scopes: oauth2?.scopes ?? ['https://www.googleapis.com/auth/drive.file'],
	};
}

interface StoredToken {
	token: string;
	expiresAt: number;
}

async function getStoredToken(): Promise<StoredToken | null> {
	const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
	return (stored[TOKEN_STORAGE_KEY] as StoredToken | undefined) ?? null;
}

async function setStoredToken(token: StoredToken | null): Promise<void> {
	if (token) {
		await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: token });
	} else {
		await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
	}
}

async function getStoredSpreadsheetId(): Promise<string | null> {
	const stored = await chrome.storage.local.get(SPREADSHEET_STORAGE_KEY);
	return (stored[SPREADSHEET_STORAGE_KEY] as string | undefined) ?? null;
}

async function setStoredSpreadsheetId(id: string): Promise<void> {
	await chrome.storage.local.set({ [SPREADSHEET_STORAGE_KEY]: id });
}

async function getPreparedIds(): Promise<string[]> {
	const stored = await chrome.storage.local.get(PREPARED_STORAGE_KEY);
	return (stored[PREPARED_STORAGE_KEY] as string[] | undefined) ?? [];
}

async function markPrepared(id: string): Promise<void> {
	const ids = await getPreparedIds();
	if (!ids.includes(id)) {
		await chrome.storage.local.set({ [PREPARED_STORAGE_KEY]: [...ids, id] });
	}
}

function spreadsheetUrl(id: string): string {
	return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

// Reason the last interactive sign-in failed, surfaced to the panel so failures
// aren't a generic "Sign-in failed".
let lastAuthError = '';

// OAuth implicit flow via launchWebAuthFlow. Tokens are cached in storage (the
// service worker / event page can be torn down between calls).
async function getAuthToken(interactive: boolean): Promise<string | null> {
	const cached = await getStoredToken();
	if (cached && cached.expiresAt > Date.now() + 60000) {
		return cached.token;
	}

	const { clientId, scopes } = getOAuthConfig();
	const redirectUri = chrome.identity.getRedirectURL();
	console.log('[PASRS] auth redirect_uri:', redirectUri);
	const authParams = new URLSearchParams({
		client_id: clientId,
		response_type: 'token',
		redirect_uri: redirectUri,
		scope: scopes.join(' '),
		prompt: interactive ? 'consent' : 'none',
	});
	const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

	let responseUrl: string | undefined;
	try {
		responseUrl = await chrome.identity.launchWebAuthFlow({
			url: authUrl,
			interactive,
		});
	} catch (error) {
		lastAuthError = `Auth window failed: ${error}`;
		console.error('[PASRS]', lastAuthError);
		return null;
	}
	if (!responseUrl) {
		lastAuthError = 'Sign-in was cancelled or blocked';
		console.error('[PASRS]', lastAuthError, '(no redirect)');
		return null;
	}

	// Google returns either a token (#access_token=…) or an error
	// (?error=… / #error=…) in the redirect.
	const hash = responseUrl.split('#')[1] ?? '';
	const query = responseUrl.split('?')[1]?.split('#')[0] ?? '';
	const params = new URLSearchParams(hash || query);
	const oauthError = params.get('error');
	if (oauthError) {
		lastAuthError = `Google: ${oauthError}${
			params.get('error_description')
				? ` — ${params.get('error_description')}`
				: ''
		}`;
		console.error('[PASRS]', lastAuthError);
		return null;
	}
	const token = params.get('access_token');
	if (!token) {
		lastAuthError = 'No access token returned';
		console.error('[PASRS]', lastAuthError, responseUrl);
		return null;
	}

	lastAuthError = '';
	const expiresIn = Number(params.get('expires_in') ?? '3600');
	await setStoredToken({ token, expiresAt: Date.now() + expiresIn * 1000 });
	return token;
}

// Drop the cached token so the next sign-in is clean. Used on sign-out and
// after a 401 (stale/revoked token).
async function removeCachedToken(token: string): Promise<void> {
	await setStoredToken(null);
	try {
		await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
	} catch {
		// Best-effort revoke; ignore network failures.
	}
}

// ---------------------------------------------------------------------------
// Sheets API helpers
// ---------------------------------------------------------------------------

interface TokenRef {
	token: string;
}

// fetch() that retries once on a network-level failure, then throws a labelled
// error so failures are diagnosable.
async function fetchWithRetry(
	label: string,
	request: () => Promise<Response>,
): Promise<Response> {
	try {
		return await request();
	} catch {
		try {
			return await request();
		} catch (error) {
			throw new Error(`Network error (${label}): ${error}`);
		}
	}
}

// Low-level Sheets API call with one automatic token refresh on 401.
async function sheetsCall(
	tokenRef: TokenRef,
	path: string,
	method: string,
	body?: unknown,
): Promise<Response> {
	const label = `Sheets ${method} ${path.split('/').pop()?.split('?')[0]}`;
	const doFetch = (token: string) =>
		fetchWithRetry(label, () =>
			fetch(`${SHEETS_API}/${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);

	let response = await doFetch(tokenRef.token);
	if (response.status === 401) {
		await removeCachedToken(tokenRef.token);
		const refreshed = await getAuthToken(false);
		if (refreshed) {
			tokenRef.token = refreshed;
			response = await doFetch(refreshed);
		}
	}
	return response;
}

async function expectOk(response: Response): Promise<void> {
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`Sheets API ${response.status}: ${text}`);
	}
}

// Upload the bundled xlsx template to Drive, converting it to a Google Sheet,
// and return the new spreadsheet's id. Needs only the drive.file scope (the
// extension is creating the file).
async function createFromTemplate(tokenRef: TokenRef): Promise<string> {
	const templateRes = await fetchWithRetry('template', () =>
		fetch(chrome.runtime.getURL(TEMPLATE_FILE)),
	);
	if (!templateRes.ok) throw new Error('Bundled template missing');
	const xlsx = await templateRes.blob();

	const boundary = `pasrs${Date.now()}`;
	const metadata = {
		name: NEW_SHEET_NAME,
		mimeType: 'application/vnd.google-apps.spreadsheet',
	};
	const body = new Blob([
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
		JSON.stringify(metadata),
		`\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
		xlsx,
		`\r\n--${boundary}--`,
	]);

	const upload = (token: string) =>
		fetchWithRetry('drive create', () =>
			fetch(DRIVE_UPLOAD, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': `multipart/related; boundary=${boundary}`,
				},
				body,
			}),
		);

	let response = await upload(tokenRef.token);
	if (response.status === 401) {
		await removeCachedToken(tokenRef.token);
		const refreshed = await getAuthToken(false);
		if (refreshed) {
			tokenRef.token = refreshed;
			response = await upload(refreshed);
		}
	}
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`Drive API ${response.status}: ${text}`);
	}
	const json = (await response.json()) as { id?: string };
	if (!json.id) throw new Error('Drive create returned no file id');
	return json.id;
}

// Drive files.get to detect a trashed file. Returns false if Drive can't tell
// us (e.g. a sheet the app didn't create), so we never discard a usable sheet.
async function isTrashed(tokenRef: TokenRef, id: string): Promise<boolean> {
	const url = `https://www.googleapis.com/drive/v3/files/${id}?fields=trashed`;
	const doFetch = (token: string) =>
		fetchWithRetry('drive get', () =>
			fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
		);
	let response = await doFetch(tokenRef.token);
	if (response.status === 401) {
		await removeCachedToken(tokenRef.token);
		const refreshed = await getAuthToken(false);
		if (refreshed) {
			tokenRef.token = refreshed;
			response = await doFetch(refreshed);
		}
	}
	if (!response.ok) return false;
	const json = (await response.json()) as { trashed?: boolean };
	return json.trashed === true;
}

// A spreadsheet is usable if the Sheets API can reach it (not deleted / no
// access) and it isn't in the trash.
async function isUsableSpreadsheet(
	tokenRef: TokenRef,
	id: string,
): Promise<boolean> {
	const response = await sheetsCall(
		tokenRef,
		`${id}?fields=spreadsheetId`,
		'GET',
	);
	if (response.status === 404 || response.status === 403) return false;
	if (!response.ok) return true; // transient error — don't throw away the sheet
	return !(await isTrashed(tokenRef, id));
}

// Use the provided id (or stored one) if it's still usable; otherwise auto-create
// a fresh tracker. This makes the tracker self-healing — if you trash or lose the
// old sheet, the next recorded game just makes a new one.
async function resolveSpreadsheetId(
	tokenRef: TokenRef,
	provided?: string,
): Promise<string> {
	const existing = provided || (await getStoredSpreadsheetId());
	if (existing && (await isUsableSpreadsheet(tokenRef, existing))) {
		return existing;
	}
	const id = await createFromTemplate(tokenRef);
	await setStoredSpreadsheetId(id);
	return id;
}

function encodeA1(sheet: string, cell: string): string {
	return encodeURIComponent(`'${sheet.replace(/'/g, "''")}'!${cell}`);
}

async function readValues(
	tokenRef: TokenRef,
	spreadsheetId: string,
	sheet: string,
	cell: string,
): Promise<string[][]> {
	const response = await sheetsCall(
		tokenRef,
		`${spreadsheetId}/values/${encodeA1(sheet, cell)}`,
		'GET',
	);
	await expectOk(response);
	const json = (await response.json()) as { values?: string[][] };
	return json.values ?? [];
}

async function writeCell(
	tokenRef: TokenRef,
	spreadsheetId: string,
	sheet: string,
	cell: string,
	value: string,
): Promise<void> {
	const response = await sheetsCall(
		tokenRef,
		`${spreadsheetId}/values/${encodeA1(sheet, cell)}?valueInputOption=USER_ENTERED`,
		'PUT',
		{ values: [[value]] },
	);
	await expectOk(response);
}

// Write a single horizontal row of raw values (RAW preserves exactly what the
// parser produced — e.g. ELO strings like "1042" stay strings, the winner stays
// numeric — matching the template's original spill).
async function writeRowRaw(
	tokenRef: TokenRef,
	spreadsheetId: string,
	sheet: string,
	range: string,
	values: Array<string | number>,
): Promise<void> {
	const response = await sheetsCall(
		tokenRef,
		`${spreadsheetId}/values/${encodeA1(sheet, range)}?valueInputOption=RAW`,
		'PUT',
		{ values: [values] },
	);
	await expectOk(response);
}

// Write a vertical column of raw values starting at the given top cell.
async function writeColumnRaw(
	tokenRef: TokenRef,
	spreadsheetId: string,
	sheet: string,
	range: string,
	values: string[],
): Promise<void> {
	const response = await sheetsCall(
		tokenRef,
		`${spreadsheetId}/values/${encodeA1(sheet, range)}?valueInputOption=RAW`,
		'PUT',
		{ values: values.map((v) => [v]) },
	);
	await expectOk(response);
}

// Without the template's bound Apps Script, the `=REPLAYTODATA(...)` cells
// (Base Data B3:B102) and `=TEAMDATAFROMPASTE(...)` cell (Team Info A1) resolve
// to #NAME? errors, which would poison every dashboard's formulas. The extension
// produces those values itself, so we clear those cells once per spreadsheet
// (leaving unfilled rows genuinely blank). This is data-safe: if B3 already
// holds real data, the sheet was prepared before — we just record the flag.
async function ensurePrepared(
	tokenRef: TokenRef,
	spreadsheetId: string,
): Promise<void> {
	const prepared = await getPreparedIds();
	if (prepared.includes(spreadsheetId)) return;

	const b3 = await readValues(tokenRef, spreadsheetId, BASE_DATA, 'B3');
	const value = (b3[0]?.[0] ?? '').trim();
	const isFresh = value === '' || value.startsWith('#');
	if (isFresh) {
		const response = await sheetsCall(
			tokenRef,
			`${spreadsheetId}/values:batchClear`,
			'POST',
			{
				ranges: [
					`'${BASE_DATA}'!B${BASE_DATA_FIRST_ROW}:${BASE_DATA_LAST_SPILL_COL}102`,
					`'${TEAM_INFO}'!A1:A100`,
					// Also reset the HomePage inputs so a sheet created from the
					// bundled template doesn't start with the template's sample data.
					`'${HOMEPAGE}'!${REPLAY_RANGE}`,
					`'${HOMEPAGE}'!${NAME_CELL}`,
					`'${HOMEPAGE}'!${PASTE_CELL}`,
				],
			},
		);
		await expectOk(response);
	}
	await markPrepared(spreadsheetId);
}

// Fetch the replay log JSON (lives at `<replay url>.json`). Covered by the
// pokemonshowdown.com host permission.
async function fetchReplayJson(url: string): Promise<string> {
	const response = await fetchWithRetry('replay json', () =>
		fetch(replayJsonUrl(url)),
	);
	if (!response.ok) {
		throw new Error(`Could not fetch replay (${response.status})`);
	}
	return response.text();
}

// Fetch a pokepaste HTML page (covered by the pokepast.es host permission).
async function fetchPasteHtml(url: string): Promise<string> {
	const response = await fetchWithRetry('pokepaste', () => fetch(url));
	if (!response.ok) {
		throw new Error(`Could not fetch pokepaste (${response.status})`);
	}
	return response.text();
}

// Trim/pad a parsed row to a fixed width so writing it cleanly overwrites any
// stale spill cells without ever touching the helper-formula columns.
function padTo(
	values: Array<string | number>,
	width: number,
): Array<string | number> {
	const out = values.slice(0, width);
	while (out.length < width) out.push('');
	return out;
}

// The set of tab titles present, to confirm this is a PASRS spreadsheet.
async function getSheetTitles(
	tokenRef: TokenRef,
	spreadsheetId: string,
): Promise<Set<string>> {
	const response = await sheetsCall(
		tokenRef,
		`${spreadsheetId}?fields=sheets.properties.title`,
		'GET',
	);
	await expectOk(response);
	const json = (await response.json()) as {
		sheets?: Array<{ properties?: { title?: string } }>;
	};
	return new Set(
		(json.sheets ?? [])
			.map((s) => s.properties?.title)
			.filter((t): t is string => Boolean(t)),
	);
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleLog(data?: SheetsRequestData): Promise<SheetsResponse> {
	const url = data?.payload?.url?.trim();
	if (!url) return { ok: false, error: 'No replay URL' };

	const provided = data?.spreadsheetId?.trim();
	const initialToken = await getAuthToken(false);
	if (!initialToken) return { ok: false, error: 'Not signed in' };
	const tokenRef: TokenRef = { token: initialToken };

	try {
		const spreadsheetId = await resolveSpreadsheetId(tokenRef, provided);
		const titles = await getSheetTitles(tokenRef, spreadsheetId);
		if (!titles.has(HOMEPAGE) || !titles.has(BASE_DATA)) {
			return {
				ok: false,
				error:
					"That spreadsheet isn't a PASRS tracker (no 'HomePage' / 'Base Data').",
			};
		}
		// Remember whatever we actually resolved (the provided id, or a freshly
		// created one if the old sheet was missing/trashed).
		await setStoredSpreadsheetId(spreadsheetId);
		await ensurePrepared(tokenRef, spreadsheetId);

		// Avoid duplicates and find the next free replay row.
		const existing = await readValues(
			tokenRef,
			spreadsheetId,
			HOMEPAGE,
			REPLAY_RANGE,
		);
		const links = existing.map((row) => (row[0] ?? '').trim());
		if (links.includes(url)) {
			return {
				ok: true,
				spreadsheetId,
				spreadsheetUrl: spreadsheetUrl(spreadsheetId),
			};
		}
		const filled = links.filter(Boolean).length;
		if (filled >= REPLAY_MAX) {
			return { ok: false, error: 'Replay list is full (100 games)' };
		}

		// Parse the replay and write its data row first, so the dashboards never
		// see a replay link without its computed data. Row N in Base Data pairs
		// with replay-link row N on the HomePage.
		const jsonText = await fetchReplayJson(url);
		const dataRow = padTo(replayToData(url, jsonText), BASE_DATA_SPILL_WIDTH);
		const baseRow = BASE_DATA_FIRST_ROW + filled;
		await writeRowRaw(
			tokenRef,
			spreadsheetId,
			BASE_DATA,
			`B${baseRow}:${BASE_DATA_LAST_SPILL_COL}${baseRow}`,
			dataRow,
		);

		await writeCell(
			tokenRef,
			spreadsheetId,
			HOMEPAGE,
			`C${REPLAY_FIRST_ROW + filled}`,
			url,
		);

		// Set the Showdown name once (so the template attributes games to you).
		const playerName = data?.payload?.playerName?.trim();
		if (playerName) {
			const nameCell = await readValues(
				tokenRef,
				spreadsheetId,
				HOMEPAGE,
				NAME_CELL,
			);
			if (!(nameCell[0]?.[0] ?? '').trim()) {
				await writeCell(
					tokenRef,
					spreadsheetId,
					HOMEPAGE,
					NAME_CELL,
					playerName,
				);
			}
		}

		return {
			ok: true,
			spreadsheetId,
			spreadsheetUrl: spreadsheetUrl(spreadsheetId),
		};
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

// Write the player's team into `Team Info From Paste` so the Usage Stats
// dashboard (which is keyed off the player's own team) renders. The team comes
// either pre-built from a chosen Showdown team (data.teamData) or from a
// pokepaste URL the background fetches and parses.
async function handleTeam(data?: SheetsRequestData): Promise<SheetsResponse> {
	const teamData = data?.teamData;
	const pasteUrl = data?.teamPasteUrl?.trim();
	if ((!teamData || teamData.length === 0) && !pasteUrl) {
		return { ok: false, error: 'No team selected' };
	}

	const provided = data?.spreadsheetId?.trim();
	const initialToken = await getAuthToken(false);
	if (!initialToken) return { ok: false, error: 'Not signed in' };
	const tokenRef: TokenRef = { token: initialToken };

	try {
		const spreadsheetId = await resolveSpreadsheetId(tokenRef, provided);
		const titles = await getSheetTitles(tokenRef, spreadsheetId);
		if (!titles.has(TEAM_INFO)) {
			return {
				ok: false,
				error: "That spreadsheet isn't a PASRS tracker.",
			};
		}
		// Remember whatever we actually resolved (the provided id, or a freshly
		// created one if the old sheet was missing/trashed).
		await setStoredSpreadsheetId(spreadsheetId);
		await ensurePrepared(tokenRef, spreadsheetId);

		let team: string[];
		if (teamData && teamData.length > 0) {
			team = teamData;
		} else {
			const html = await fetchPasteHtml(pasteUrl as string);
			team = teamFromPaste(html);
		}
		if (team.length === 0) {
			return { ok: false, error: 'No Pokémon found in that team' };
		}
		await writeColumnRaw(
			tokenRef,
			spreadsheetId,
			TEAM_INFO,
			`A1:A${team.length}`,
			team,
		);
		// Record the source paste on the HomePage too (harmless if unused).
		if (pasteUrl) {
			await writeCell(tokenRef, spreadsheetId, HOMEPAGE, PASTE_CELL, pasteUrl);
		}

		return {
			ok: true,
			spreadsheetId,
			spreadsheetUrl: spreadsheetUrl(spreadsheetId),
		};
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

// Explicitly create a fresh tracker from the bundled template (the "Create
// tracker" button), prepare it, and return its id so the UI can fill it in.
async function handleCreate(): Promise<SheetsResponse> {
	const initialToken = await getAuthToken(false);
	if (!initialToken) return { ok: false, error: 'Not signed in' };
	const tokenRef: TokenRef = { token: initialToken };
	try {
		const id = await createFromTemplate(tokenRef);
		await setStoredSpreadsheetId(id);
		await ensurePrepared(tokenRef, id);
		return {
			ok: true,
			spreadsheetId: id,
			spreadsheetUrl: spreadsheetUrl(id),
		};
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

// Report which spreadsheet will be used so the settings panel can link to it.
async function handleSpreadsheet(
	data?: SheetsRequestData,
): Promise<SheetsResponse> {
	const provided = data?.spreadsheetId?.trim();
	const id = provided || (await getStoredSpreadsheetId());
	if (!id) return { ok: true };
	return { ok: true, spreadsheetId: id, spreadsheetUrl: spreadsheetUrl(id) };
}

async function handleMessage(
	message: BackgroundMessage,
): Promise<SheetsResponse> {
	switch (message.action) {
		case 'auth': {
			const token = await getAuthToken(true);
			return {
				ok: !!token,
				signedIn: !!token,
				error: token ? undefined : lastAuthError || undefined,
			};
		}
		case 'status': {
			const token = await getAuthToken(false);
			return { ok: true, signedIn: !!token };
		}
		case 'signout': {
			const token = await getAuthToken(false);
			if (token) await removeCachedToken(token);
			return { ok: true, signedIn: false };
		}
		case 'log':
			return handleLog(message.data);
		case 'team':
			return handleTeam(message.data);
		case 'create':
			return handleCreate();
		case 'spreadsheet':
			return handleSpreadsheet(message.data);
		default:
			return { ok: false, error: `Unknown action: ${message.action}` };
	}
}

chrome.runtime.onMessage.addListener(
	(message: BackgroundMessage, _sender, sendResponse) => {
		console.log('[PASRS] request:', message.action, message.data);
		handleMessage(message)
			.then((response) => {
				console.log('[PASRS] response:', message.action, response);
				sendResponse(response);
			})
			.catch((error) => {
				console.error('[PASRS] handler threw:', message.action, error);
				sendResponse({ ok: false, error: String(error) });
			});
		return true; // keep the message channel open for the async response
	},
);
