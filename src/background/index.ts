import type {
	SheetsAction,
	SheetsRequestData,
	SheetsResponse,
} from '../lib/events';

// Background service worker: the only context that may use chrome.identity and
// hold an OAuth token. It signs the user in and appends recorded replay URLs to
// the HomePage of their PASRS spreadsheet, which the template's own Apps Script
// (REPLAYTODATA / TEAMDATAFROMPASTE) turns into all the dashboards.
//
// Messages arrive from the content script (which relays them from the page).

interface BackgroundMessage {
	action: SheetsAction;
	data?: SheetsRequestData;
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_STORAGE_KEY = 'pasrs_sheets_token';
const SPREADSHEET_STORAGE_KEY = 'pasrs_sheets_spreadsheet_id';

// PASRS HomePage layout: replay links go in C14:C113, the Showdown name in G6.
const HOMEPAGE = 'HomePage';
const REPLAY_RANGE = 'C14:C113';
const REPLAY_FIRST_ROW = 14;
const REPLAY_MAX = 100;
const NAME_CELL = 'G6';

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
	const spreadsheetId = provided || (await getStoredSpreadsheetId());
	if (!spreadsheetId) {
		return {
			ok: false,
			error: 'Set your PASRS spreadsheet ID in settings first',
		};
	}

	const initialToken = await getAuthToken(false);
	if (!initialToken) return { ok: false, error: 'Not signed in' };
	const tokenRef: TokenRef = { token: initialToken };

	try {
		const titles = await getSheetTitles(tokenRef, spreadsheetId);
		if (!titles.has(HOMEPAGE)) {
			return {
				ok: false,
				error:
					"That spreadsheet has no 'HomePage' — make a copy of the PASRS sheet (File → Make a copy) and use its ID.",
			};
		}
		if (provided) await setStoredSpreadsheetId(provided);

		// Avoid duplicates and find the next free replay-link row.
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
			return { ok: false, error: 'Replay list is full (100 links)' };
		}
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
