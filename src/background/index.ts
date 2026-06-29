import type {
	SheetsAction,
	SheetsLogPayload,
	SheetsRequestData,
	SheetsResponse,
} from '../lib/events';

// Background service worker: the only context that may use chrome.identity and
// hold an OAuth token. It authenticates the user against their Google account
// and appends recorded battles to the "GBG Data" sheet of their PASRS 4.3
// spreadsheet via the Sheets REST API.
//
// Messages arrive from the content script (which relays them from the page).

interface BackgroundMessage {
	action: SheetsAction;
	data?: SheetsRequestData;
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_STORAGE_KEY = 'pasrs_sheets_token';
const SPREADSHEET_STORAGE_KEY = 'pasrs_sheets_spreadsheet_id';
// The raw-input sheet of the PASRS 4.3 template; everything else is computed
// from it. Data rows start at row 2 (row 1 is the header).
const GBG_SHEET = 'GBG Data';
const GBG_FIRST_DATA_ROW = 2;
const GBG_COLUMN_COUNT = 32; // A..AF

// ---------------------------------------------------------------------------
// Auth (launchWebAuthFlow on every browser — see notes below)
// ---------------------------------------------------------------------------

// chrome.identity.getAuthToken is intentionally not used: it only works
// reliably in Google Chrome and needs a different OAuth client type. One web
// flow = one OAuth client (Web application), one code path across Chrome,
// Chromium forks, and Firefox.
function getOAuthConfig(): { clientId: string; scopes: string[] } {
	const oauth2 = (
		chrome.runtime.getManifest() as chrome.runtime.Manifest & {
			oauth2?: { client_id: string; scopes: string[] };
		}
	).oauth2;
	return {
		clientId: oauth2?.client_id ?? '',
		scopes: oauth2?.scopes ?? ['https://www.googleapis.com/auth/spreadsheets'],
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

const TEMPLATE_FILE = 'pasrs-template.xlsx';
const SPREADSHEET_TITLE = 'PASRS Helper Tracker';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const XLSX_MIME =
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Auto-create the tracker by uploading the bundled PASRS template to the user's
// Drive, converting it to a Google Sheet. Uses Drive's multipart upload; the
// drive.file scope is enough because the app is creating the file.
async function createFromTemplate(token: string): Promise<string> {
	const fileBytes = await fetchWithRetry('read bundled template', () =>
		fetch(chrome.runtime.getURL(TEMPLATE_FILE)),
	).then((r) => r.blob());

	const boundary = `pasrs${Date.now()}`;
	const metadata = { name: SPREADSHEET_TITLE, mimeType: SHEET_MIME };
	const body = new Blob([
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
		JSON.stringify(metadata),
		`\r\n--${boundary}\r\nContent-Type: ${XLSX_MIME}\r\n\r\n`,
		fileBytes,
		`\r\n--${boundary}--`,
	]);

	const response = await fetchWithRetry('Drive upload', () =>
		fetch(
			'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': `multipart/related; boundary=${boundary}`,
				},
				body,
			},
		),
	);
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`Drive API ${response.status}: ${text}`);
	}
	const json = (await response.json()) as { id: string };
	return json.id;
}

// Whether the stored spreadsheet still exists and isn't in the trash. A trashed
// file is still readable by ID via the Sheets API, so we check Drive explicitly
// (drive.file can see files the app created).
async function isLiveFile(
	tokenRef: TokenRef,
	spreadsheetId: string,
): Promise<boolean> {
	const response = await fetchWithRetry('Drive get', () =>
		fetch(
			`https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=trashed`,
			{ headers: { Authorization: `Bearer ${tokenRef.token}` } },
		),
	);
	if (!response.ok) return false; // 404 / no access -> treat as gone
	const json = (await response.json()) as { trashed?: boolean };
	return json.trashed !== true;
}

// Whether the spreadsheet contains a "GBG Data" sheet (i.e. it's a PASRS
// tracker). Returns false if the spreadsheet is missing/inaccessible.
async function hasGbgSheet(
	tokenRef: TokenRef,
	spreadsheetId: string,
): Promise<boolean> {
	const response = await sheetsCall(
		tokenRef,
		`${spreadsheetId}?fields=sheets.properties.title`,
		'GET',
	);
	if (!response.ok) {
		if (response.status === 403 || response.status === 404) return false;
		await expectOk(response); // surface auth/other errors
	}
	const json = (await response.json()) as {
		sheets?: Array<{ properties?: { title?: string } }>;
	};
	return (json.sheets ?? []).some((s) => s.properties?.title === GBG_SHEET);
}

// Resolve which spreadsheet to write to: the user's own ID if provided,
// otherwise the remembered auto-created one, creating it from the template on
// first use. A stored ID that no longer has a GBG Data sheet (e.g. left over
// from an older version) is discarded and recreated.
async function ensureSpreadsheetId(
	tokenRef: TokenRef,
	userProvidedId?: string,
): Promise<string> {
	const provided = userProvidedId?.trim();
	if (provided) {
		if (!(await hasGbgSheet(tokenRef, provided))) {
			throw new Error(
				"That spreadsheet has no 'GBG Data' sheet — use a PASRS 4.3 copy, or leave the ID blank to auto-create one.",
			);
		}
		await setStoredSpreadsheetId(provided);
		return provided;
	}

	const stored = await getStoredSpreadsheetId();
	if (
		stored &&
		(await isLiveFile(tokenRef, stored)) &&
		(await hasGbgSheet(tokenRef, stored))
	) {
		return stored;
	}

	const created = await createFromTemplate(tokenRef.token);
	await setStoredSpreadsheetId(created);
	// The bundled template ships with sample games; clear them so logging starts
	// at game 1 in a freshly created tracker.
	await clearGbgData(tokenRef, created);
	return created;
}

// Wipe the GBG Data input rows (keeping the header). Best-effort.
async function clearGbgData(
	tokenRef: TokenRef,
	spreadsheetId: string,
): Promise<void> {
	try {
		const range = encodeA1(GBG_SHEET, `A${GBG_FIRST_DATA_ROW}:AF`);
		await sheetsCall(
			tokenRef,
			`${spreadsheetId}/values/${range}:clear`,
			'POST',
			{},
		);
	} catch {
		// ignore — a stray sample row is non-fatal
	}
}

function spreadsheetUrl(id: string): string {
	return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

// OAuth implicit flow via launchWebAuthFlow. Tokens are cached in storage (the
// service worker / event page can be torn down between calls).
async function getAuthToken(interactive: boolean): Promise<string | null> {
	const cached = await getStoredToken();
	if (cached && cached.expiresAt > Date.now() + 60000) {
		return cached.token;
	}

	const { clientId, scopes } = getOAuthConfig();
	const redirectUri = chrome.identity.getRedirectURL();
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
	} catch {
		return null;
	}
	if (!responseUrl) return null;

	const fragment = responseUrl.split('#')[1] ?? '';
	const params = new URLSearchParams(fragment);
	const token = params.get('access_token');
	if (!token) return null;

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

// A short-lived holder so a 401 mid-sequence can swap in a refreshed token.
interface TokenRef {
	token: string;
}

// fetch() that retries once on a network-level failure and, on a second
// failure, throws a labelled error so we know which request died.
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

// Encode an A1 range like  'GBG Data'!A5  (sheet name single-quoted, escaped).
function encodeA1(sheet: string, cell: string): string {
	return encodeURIComponent(`'${sheet.replace(/'/g, "''")}'!${cell}`);
}

// Count existing data rows by reading column B (Game number) from row 2 down.
async function countDataRows(
	tokenRef: TokenRef,
	spreadsheetId: string,
): Promise<number> {
	const range = encodeA1(GBG_SHEET, `B${GBG_FIRST_DATA_ROW}:B`);
	const response = await sheetsCall(
		tokenRef,
		`${spreadsheetId}/values/${range}`,
		'GET',
	);
	await expectOk(response);
	const json = (await response.json()) as { values?: string[][] };
	return json.values?.length ?? 0;
}

// Write a single row at the given 1-based row number.
async function writeRowAt(
	tokenRef: TokenRef,
	spreadsheetId: string,
	rowNumber: number,
	row: string[],
): Promise<void> {
	const range = encodeA1(GBG_SHEET, `A${rowNumber}`);
	const response = await sheetsCall(
		tokenRef,
		`${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
		'PUT',
		{ values: [row] },
	);
	await expectOk(response);
}

// ---------------------------------------------------------------------------
// GBG Data row construction
// ---------------------------------------------------------------------------

// 0-based column index for an A1 column letter (A=0 … AF=31).
function colIndex(letter: string): number {
	let n = 0;
	for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

function eloCell(before: string, after: string): string {
	if (before && after) return `${before} -> ${after}`;
	return after || before || '';
}

// Lay a battle out across the PASRS GBG Data columns (A..AF), leaving the
// template's spacer columns blank.
function buildGbgRow(gameNumber: number, payload: SheetsLogPayload): string[] {
	const row = new Array<string>(GBG_COLUMN_COUNT).fill('');
	const set = (letter: string, value: string) => {
		row[colIndex(letter)] = value ?? '';
	};

	set('B', String(gameNumber));
	set('C', payload.result);
	set('D', 'vs');
	set('E', payload.oppName);

	const oppCols = ['F', 'G', 'H', 'I', 'J', 'K'];
	payload.oppTeam.slice(0, 6).forEach((mon, i) => set(oppCols[i], mon));

	const myPickCols = ['O', 'P', 'Q', 'R']; // lead1, lead2, back1, back2
	payload.myPicks.slice(0, 4).forEach((mon, i) => set(myPickCols[i], mon));

	const oppPickCols = ['T', 'U', 'V', 'W'];
	payload.oppPicks.slice(0, 4).forEach((mon, i) => set(oppPickCols[i], mon));

	set('Z', payload.myTeraMon);
	set('AA', payload.myTeraType);
	set('AB', payload.oppTeraMon);
	set('AC', payload.oppTeraType);
	set('AD', payload.ots ? 'Yes' : '');
	set('AE', eloCell(payload.myEloBefore, payload.myEloAfter));
	set('AF', payload.oppElo);

	return row;
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleLog(data?: SheetsRequestData): Promise<SheetsResponse> {
	const payload = data?.payload;
	if (!payload) return { ok: false, error: 'No replay data' };

	const initialToken = await getAuthToken(false);
	if (!initialToken) return { ok: false, error: 'Not signed in' };
	const tokenRef: TokenRef = { token: initialToken };

	try {
		const spreadsheetId = await ensureSpreadsheetId(
			tokenRef,
			data?.spreadsheetId,
		);
		const count = await countDataRows(tokenRef, spreadsheetId);
		const gameNumber = count + 1;
		const rowNumber = GBG_FIRST_DATA_ROW + count;
		await writeRowAt(
			tokenRef,
			spreadsheetId,
			rowNumber,
			buildGbgRow(gameNumber, payload),
		);
		return {
			ok: true,
			spreadsheetId,
			spreadsheetUrl: spreadsheetUrl(spreadsheetId),
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
			return { ok: !!token, signedIn: !!token };
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
		case 'spreadsheet':
			return handleSpreadsheet(message.data);
		default:
			return { ok: false, error: `Unknown action: ${message.action}` };
	}
}

chrome.runtime.onMessage.addListener(
	(message: BackgroundMessage, _sender, sendResponse) => {
		handleMessage(message)
			.then(sendResponse)
			.catch((error) => sendResponse({ ok: false, error: String(error) }));
		return true; // keep the message channel open for the async response
	},
);
