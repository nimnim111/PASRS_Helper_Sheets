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

// chrome.identity.getAuthToken only exists in Chromium. On Firefox we fall back
// to the standard launchWebAuthFlow OAuth dance.
const hasGetAuthToken = typeof chrome.identity?.getAuthToken === 'function';

function getOAuthConfig(): { clientId: string; scopes: string[] } {
	// On Chrome these come from the manifest's oauth2 block. On Firefox that key
	// is ignored by getAuthToken (which doesn't exist), so the launchWebAuthFlow
	// path reads the same values — register a *Web application* client whose ID
	// is set here / in the manifest and add chrome.identity.getRedirectURL() as
	// an authorized redirect URI.
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

// Firefox path: OAuth implicit flow via launchWebAuthFlow. Tokens are cached in
// storage (the service worker / event page can be torn down between calls).
async function getTokenViaWebAuthFlow(
	interactive: boolean,
): Promise<string | null> {
	const cached = await getStoredToken();
	if (cached && cached.expiresAt > Date.now() + 60000) {
		return cached.token;
	}

	const { clientId, scopes } = getOAuthConfig();
	const redirectUri = chrome.identity.getRedirectURL();
	const authUrl =
		'https://accounts.google.com/o/oauth2/v2/auth?' +
		new URLSearchParams({
			client_id: clientId,
			response_type: 'token',
			redirect_uri: redirectUri,
			scope: scopes.join(' '),
			prompt: interactive ? 'consent' : 'none',
		}).toString();

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

// Chrome path: getAuthToken handles caching, the account picker and consent.
function getTokenViaIdentity(interactive: boolean): Promise<string | null> {
	return new Promise((resolve) => {
		chrome.identity.getAuthToken({ interactive }, (token) => {
			if (chrome.runtime.lastError || !token) {
				resolve(null);
				return;
			}
			resolve(typeof token === 'string' ? token : (token.token ?? null));
		});
	});
}

// Acquire an OAuth token. interactive=true shows the Google account picker /
// consent screen; interactive=false silently returns a cached token or none.
function getAuthToken(interactive: boolean): Promise<string | null> {
	return hasGetAuthToken
		? getTokenViaIdentity(interactive)
		: getTokenViaWebAuthFlow(interactive);
}

// Drop a token so the next sign-in is clean. Used on sign-out and after a 401
// (stale/revoked token).
async function removeCachedToken(token: string): Promise<void> {
	if (hasGetAuthToken) {
		await new Promise<void>((resolve) => {
			chrome.identity.removeCachedAuthToken({ token }, () => resolve());
		});
	} else {
		await setStoredToken(null);
	}
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

async function handleLog(data?: SheetsRequestData): Promise<SheetsResponse> {
	const spreadsheetId = data?.spreadsheetId?.trim();
	const payload = data?.payload;
	if (!spreadsheetId) return { ok: false, error: 'No spreadsheet ID set' };
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
	return { ok: true };
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
