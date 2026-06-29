import type {
	SheetsAction,
	SheetsRequestData,
	SheetsResponse,
} from '../lib/events';

// Background service worker: the only context that may use chrome.identity and
// hold an OAuth token. It authenticates the user against their Google account
// and appends recorded replays to their spreadsheet via the Sheets REST API.
//
// Messages arrive from the content script (which relays them from the page).

interface BackgroundMessage {
	action: SheetsAction;
	data?: SheetsRequestData;
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Auth uses launchWebAuthFlow on every browser (Chrome, Chromium forks like
// Brave/Edge, and Firefox). chrome.identity.getAuthToken is intentionally not
// used: it only works reliably in Google Chrome and needs a different OAuth
// client type. One web flow = one OAuth client, one code path.
function getOAuthConfig(): { clientId: string; scopes: string[] } {
	// Configured via the manifest's oauth2 block. Register a *Web application*
	// OAuth client and add chrome.identity.getRedirectURL() as an authorized
	// redirect URI (it differs per browser: *.chromiumapp.org on Chromium,
	// *.extensions.allizom.org on Firefox).
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

const TOKEN_STORAGE_KEY = 'pasrs_sheets_token';
// The auto-created spreadsheet, remembered so we reuse the same one. Used only
// when the user hasn't supplied their own spreadsheet ID.
const SPREADSHEET_STORAGE_KEY = 'pasrs_sheets_spreadsheet_id';
const SPREADSHEET_TITLE = 'PASRS Helper Replays';
const HEADER_ROW = [
	'Timestamp',
	'Format',
	'Player 1',
	'Player 2',
	'Result',
	'Replay URL',
];

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

async function setStoredSpreadsheetId(id: string | null): Promise<void> {
	if (id) {
		await chrome.storage.local.set({ [SPREADSHEET_STORAGE_KEY]: id });
	} else {
		await chrome.storage.local.remove(SPREADSHEET_STORAGE_KEY);
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

async function appendRow(
	token: string,
	spreadsheetId: string,
	sheetName: string,
	row: Array<string | number>,
): Promise<Response> {
	const range = encodeURIComponent(`${sheetName}!A1`);
	const url = `${SHEETS_API}/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
	return fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ values: [row] }),
	});
}

// Create a fresh spreadsheet with a header row and return its ID.
async function createSpreadsheet(token: string): Promise<string> {
	const response = await fetch(SHEETS_API, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			properties: { title: SPREADSHEET_TITLE },
			sheets: [
				{
					properties: { title: 'Sheet1' },
					data: [
						{
							startRow: 0,
							startColumn: 0,
							rowData: [
								{
									values: HEADER_ROW.map((header) => ({
										userEnteredValue: { stringValue: header },
									})),
								},
							],
						},
					],
				},
			],
		}),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`Sheets API ${response.status}: ${text}`);
	}
	const json = (await response.json()) as { spreadsheetId: string };
	return json.spreadsheetId;
}

// Resolve which spreadsheet to write to: the user's own ID if provided,
// otherwise the remembered auto-created one, creating it on first use.
async function ensureSpreadsheetId(
	token: string,
	userProvidedId?: string,
): Promise<string> {
	const provided = userProvidedId?.trim();
	if (provided) return provided;

	const stored = await getStoredSpreadsheetId();
	if (stored) return stored;

	const created = await createSpreadsheet(token);
	await setStoredSpreadsheetId(created);
	return created;
}

async function handleLog(data?: SheetsRequestData): Promise<SheetsResponse> {
	const payload = data?.payload;
	if (!payload) return { ok: false, error: 'No replay data' };

	const sheetName = data?.sheetName?.trim() || 'Sheet1';
	const row = [
		new Date().toISOString(),
		payload.format,
		payload.p1,
		payload.p2,
		payload.result,
		payload.url,
	];

	let token = await getAuthToken(false);
	if (!token) return { ok: false, error: 'Not signed in' };

	const spreadsheetId = await ensureSpreadsheetId(token, data?.spreadsheetId);

	let response = await appendRow(token, spreadsheetId, sheetName, row);

	// A 401 usually means the cached token is stale or was revoked. Refresh once.
	if (response.status === 401) {
		await removeCachedToken(token);
		token = await getAuthToken(false);
		if (!token) return { ok: false, error: 'Not signed in' };
		response = await appendRow(token, spreadsheetId, sheetName, row);
	}

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		return { ok: false, error: `Sheets API ${response.status}: ${text}` };
	}
	return {
		ok: true,
		spreadsheetId,
		spreadsheetUrl: spreadsheetUrl(spreadsheetId),
	};
}

// Report which spreadsheet will be used (the user's own, or the auto-created
// one) so the settings panel can show a link, without creating anything.
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
