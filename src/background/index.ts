import type {
	SheetsAction,
	SheetsLogPayload,
	SheetsRequestData,
	SheetsResponse,
} from '../lib/events';
import type { TeamMon } from '../types/replay';

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
// Per-spreadsheet bookkeeping: which species-set maps to which tab, and the last
// known team detail for that tab (to detect item/move changes).
const META_STORAGE_KEY = 'pasrs_sheets_meta';
const SPREADSHEET_TITLE = 'PASRS Helper Replays';
// Column headers for the battle table inside each team tab.
const BATTLE_COLUMNS = [
	'Timestamp',
	'Format',
	'You',
	'Opponent',
	'Result',
	'Your Elo',
	'Elo Change',
	'Opp Elo',
	'Opp Team',
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

interface TeamTabMeta {
	tabName: string;
	detail: TeamMon[];
}

interface SpreadsheetMeta {
	teamCount: number;
	teams: Record<string, TeamTabMeta>; // keyed by sorted species set
}

type AllMeta = Record<string, SpreadsheetMeta>; // keyed by spreadsheet id

async function getAllMeta(): Promise<AllMeta> {
	const stored = await chrome.storage.local.get(META_STORAGE_KEY);
	return (stored[META_STORAGE_KEY] as AllMeta | undefined) ?? {};
}

async function setAllMeta(meta: AllMeta): Promise<void> {
	await chrome.storage.local.set({ [META_STORAGE_KEY]: meta });
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

// A short-lived holder so a 401 mid-sequence can swap in a refreshed token.
interface TokenRef {
	token: string;
}

// Low-level Sheets API call with one automatic token refresh on 401.
async function sheetsCall(
	tokenRef: TokenRef,
	path: string,
	method: string,
	body?: unknown,
): Promise<Response> {
	const doFetch = (token: string) =>
		fetch(`${SHEETS_API}/${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

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

// A1 range targeting a tab from its top-left; the name is single-quoted.
function tabRange(tabName: string): string {
	return encodeURIComponent(`'${tabName.replace(/'/g, "''")}'!A1`);
}

async function appendRows(
	tokenRef: TokenRef,
	spreadsheetId: string,
	tabName: string,
	rows: string[][],
): Promise<void> {
	const path = `${spreadsheetId}/values/${tabRange(tabName)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
	await expectOk(await sheetsCall(tokenRef, path, 'POST', { values: rows }));
}

async function writeRange(
	tokenRef: TokenRef,
	spreadsheetId: string,
	tabName: string,
	rows: string[][],
): Promise<void> {
	const path = `${spreadsheetId}/values/${tabRange(tabName)}?valueInputOption=USER_ENTERED`;
	await expectOk(await sheetsCall(tokenRef, path, 'PUT', { values: rows }));
}

// Create a fresh, empty spreadsheet (team tabs are added as battles arrive).
async function createSpreadsheet(tokenRef: TokenRef): Promise<string> {
	const response = await sheetsCall(tokenRef, '', 'POST', {
		properties: { title: SPREADSHEET_TITLE },
	});
	await expectOk(response);
	const json = (await response.json()) as { spreadsheetId: string };
	return json.spreadsheetId;
}

// Resolve which spreadsheet to write to: the user's own ID if provided,
// otherwise the remembered auto-created one, creating it on first use.
async function ensureSpreadsheetId(
	tokenRef: TokenRef,
	userProvidedId?: string,
): Promise<string> {
	const provided = userProvidedId?.trim();
	if (provided) return provided;

	const stored = await getStoredSpreadsheetId();
	if (stored) return stored;

	const created = await createSpreadsheet(tokenRef);
	await setStoredSpreadsheetId(created);
	return created;
}

function speciesKeyOf(species: string[]): string {
	if (species.length === 0) return 'unknown';
	return [...species]
		.map((s) => s.toLowerCase())
		.sort()
		.join('|');
}

// Header block placed at the top of a new team tab: the team, then the battle
// column headers. Kept contiguous (no blank rows) so append() finds the table.
function teamHeaderRows(tabName: string, team: TeamMon[]): string[][] {
	const rows: string[][] = [[tabName]];
	if (team.length > 0) {
		rows.push(['Pokémon', 'Item', 'Moves']);
		for (const mon of team) {
			rows.push([mon.species, mon.item, mon.moves]);
		}
	}
	rows.push([...BATTLE_COLUMNS]);
	return rows;
}

async function createTeamTab(
	tokenRef: TokenRef,
	spreadsheetId: string,
	tabName: string,
	team: TeamMon[],
): Promise<void> {
	const addRes = await sheetsCall(
		tokenRef,
		`${spreadsheetId}:batchUpdate`,
		'POST',
		{ requests: [{ addSheet: { properties: { title: tabName } } }] },
	);
	// Ignore "already exists" (400) so a previously half-created tab still works.
	if (!addRes.ok && addRes.status !== 400) await expectOk(addRes);
	await writeRange(
		tokenRef,
		spreadsheetId,
		tabName,
		teamHeaderRows(tabName, team),
	);
}

// Describe item/move changes between two snapshots of the same species set.
function describeTeamChanges(prev: TeamMon[], next: TeamMon[]): string {
	const prevBySpecies = new Map(prev.map((mon) => [mon.species, mon]));
	const changes: string[] = [];
	for (const mon of next) {
		const before = prevBySpecies.get(mon.species);
		if (!before) continue;
		const diffs: string[] = [];
		if (before.item !== mon.item) diffs.push(`item → ${mon.item || 'none'}`);
		if (before.moves !== mon.moves) diffs.push('moves');
		if (diffs.length > 0) changes.push(`${mon.species} (${diffs.join(', ')})`);
	}
	return changes.join('; ');
}

function buildBattleRow(payload: SheetsLogPayload): string[] {
	const you = payload.mySide === 'p2' ? payload.p2 : payload.p1;
	const opponent = payload.mySide === 'p2' ? payload.p1 : payload.p2;
	return [
		new Date().toISOString(),
		payload.format,
		you,
		opponent,
		payload.result,
		payload.myEloAfter ?? payload.myEloBefore ?? '',
		payload.myEloDelta ?? '',
		payload.oppElo ?? '',
		(payload.oppTeamSpecies ?? []).join(', '),
		payload.url,
	];
}

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

		const team = payload.myTeam ?? [];
		const key = speciesKeyOf(payload.myTeamSpecies ?? []);

		const allMeta = await getAllMeta();
		const meta = allMeta[spreadsheetId] ?? { teamCount: 0, teams: {} };
		let teamMeta = meta.teams[key];

		if (!teamMeta) {
			meta.teamCount += 1;
			const tabName = `Team ${meta.teamCount}`;
			await createTeamTab(tokenRef, spreadsheetId, tabName, team);
			teamMeta = { tabName, detail: team };
			meta.teams[key] = teamMeta;
		} else {
			const changes = describeTeamChanges(teamMeta.detail, team);
			if (changes) {
				await appendRows(tokenRef, spreadsheetId, teamMeta.tabName, [
					[`— Team updated ${new Date().toISOString()}: ${changes} —`],
				]);
				teamMeta.detail = team;
			}
		}

		allMeta[spreadsheetId] = meta;
		await setAllMeta(allMeta);

		await appendRows(tokenRef, spreadsheetId, teamMeta.tabName, [
			buildBattleRow(payload),
		]);

		return {
			ok: true,
			spreadsheetId,
			spreadsheetUrl: spreadsheetUrl(spreadsheetId),
		};
	} catch (error) {
		return { ok: false, error: String(error) };
	}
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
