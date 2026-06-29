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

// Acquire an OAuth token. interactive=true shows the Google account picker /
// consent screen; interactive=false silently returns a cached token or none.
function getAuthToken(interactive: boolean): Promise<string | null> {
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

// Drop a token both from Chrome's cache and Google's side so the next sign-in
// is clean. Used on sign-out and after a 401 (stale/revoked token).
async function removeCachedToken(token: string): Promise<void> {
	await new Promise<void>((resolve) => {
		chrome.identity.removeCachedAuthToken({ token }, () => resolve());
	});
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
