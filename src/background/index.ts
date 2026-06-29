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
	'Opp Pokepaste',
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
	// The auto-created spreadsheet's initial empty "Sheet1", deleted once the
	// first team tab exists. Only set for spreadsheets we created.
	defaultSheetId?: number;
	defaultSheetDeleted?: boolean;
}

type Color = { red: number; green: number; blue: number };

// Palette for the styled tabs.
const TITLE_BG: Color = { red: 0.12, green: 0.2, blue: 0.33 };
const HEADER_BG: Color = { red: 0.17, green: 0.24, blue: 0.31 };
const WHITE: Color = { red: 1, green: 1, blue: 1 };
const WIN_BG: Color = { red: 0.78, green: 0.92, blue: 0.79 };
const WIN_FG: Color = { red: 0.0, green: 0.38, blue: 0.0 };
const LOSS_BG: Color = { red: 0.99, green: 0.8, blue: 0.8 };
const LOSS_FG: Color = { red: 0.6, green: 0.0, blue: 0.0 };

// Pixel widths for the battle columns (A–K).
const COLUMN_WIDTHS = [170, 150, 120, 150, 70, 80, 95, 80, 230, 180, 260];
const MON_ROW_HEIGHT = 72;
const SPRITE_PX = 64;

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
async function createSpreadsheet(
	tokenRef: TokenRef,
): Promise<{ id: string; defaultSheetId?: number }> {
	const response = await sheetsCall(tokenRef, '', 'POST', {
		properties: { title: SPREADSHEET_TITLE },
	});
	await expectOk(response);
	const json = (await response.json()) as {
		spreadsheetId: string;
		sheets?: Array<{ properties?: { sheetId?: number } }>;
	};
	return {
		id: json.spreadsheetId,
		defaultSheetId: json.sheets?.[0]?.properties?.sheetId,
	};
}

// Resolve which spreadsheet to write to: the user's own ID if provided,
// otherwise the remembered auto-created one, creating it on first use. When a
// new one is created, its empty default sheet id is recorded in meta so the
// first team tab can delete it.
async function ensureSpreadsheetId(
	tokenRef: TokenRef,
	allMeta: AllMeta,
	userProvidedId?: string,
): Promise<string> {
	const provided = userProvidedId?.trim();
	if (provided) return provided;

	const stored = await getStoredSpreadsheetId();
	if (stored) return stored;

	const created = await createSpreadsheet(tokenRef);
	await setStoredSpreadsheetId(created.id);
	allMeta[created.id] = {
		teamCount: 0,
		teams: {},
		defaultSheetId: created.defaultSheetId,
	};
	return created.id;
}

function speciesKeyOf(species: string[]): string {
	if (species.length === 0) return 'unknown';
	return [...species]
		.map((s) => s.toLowerCase())
		.sort()
		.join('|');
}

// Header block placed at the top of a new team tab: the team (with a sprite
// column), then the battle column headers. Kept contiguous (no blank rows) so
// append() finds the table.
function teamHeaderRows(tabName: string, team: TeamMon[]): string[][] {
	const rows: string[][] = [[tabName]];
	if (team.length > 0) {
		rows.push(['Pokémon', 'Sprite', 'Item', 'Moves']);
		for (const mon of team) {
			const image = mon.sprite
				? `=IMAGE("${mon.sprite}", 4, ${SPRITE_PX}, ${SPRITE_PX})`
				: '';
			rows.push([mon.species, image, mon.item, mon.moves]);
		}
	}
	rows.push([...BATTLE_COLUMNS]);
	return rows;
}

function headerRowFormat(
	sheetId: number,
	rowIndex: number,
	columns: number,
	background: Color,
	fontSize?: number,
): unknown {
	return {
		repeatCell: {
			range: {
				sheetId,
				startRowIndex: rowIndex,
				endRowIndex: rowIndex + 1,
				startColumnIndex: 0,
				endColumnIndex: columns,
			},
			cell: {
				userEnteredFormat: {
					backgroundColor: background,
					verticalAlignment: 'MIDDLE',
					textFormat: {
						bold: true,
						foregroundColor: WHITE,
						...(fontSize ? { fontSize } : {}),
					},
				},
			},
			fields: 'userEnteredFormat(backgroundColor,verticalAlignment,textFormat)',
		},
	};
}

function resultColorRule(
	sheetId: number,
	firstBattleRow: number,
	value: string,
	background: Color,
	foreground: Color,
): unknown {
	return {
		addConditionalFormatRule: {
			index: 0,
			rule: {
				ranges: [
					{
						sheetId,
						startRowIndex: firstBattleRow,
						startColumnIndex: 4, // Result column (E)
						endColumnIndex: 5,
					},
				],
				booleanRule: {
					condition: {
						type: 'TEXT_EQ',
						values: [{ userEnteredValue: value }],
					},
					format: {
						backgroundColor: background,
						textFormat: { foregroundColor: foreground },
					},
				},
			},
		},
	};
}

// Build the formatting batchUpdate for a freshly created team tab.
function tabFormatRequests(
	sheetId: number,
	team: TeamMon[],
): { requests: unknown[]; battleHeaderRowIndex: number } {
	const hasTeam = team.length > 0;
	const battleHeaderRowIndex = hasTeam ? 2 + team.length : 1;
	const cols = BATTLE_COLUMNS.length;

	const requests: unknown[] = [
		headerRowFormat(sheetId, 0, cols, TITLE_BG, 13),
		headerRowFormat(sheetId, battleHeaderRowIndex, cols, HEADER_BG),
		{
			updateSheetProperties: {
				properties: {
					sheetId,
					gridProperties: { frozenRowCount: battleHeaderRowIndex + 1 },
				},
				fields: 'gridProperties.frozenRowCount',
			},
		},
		resultColorRule(sheetId, battleHeaderRowIndex + 1, 'win', WIN_BG, WIN_FG),
		resultColorRule(
			sheetId,
			battleHeaderRowIndex + 1,
			'loss',
			LOSS_BG,
			LOSS_FG,
		),
	];

	COLUMN_WIDTHS.forEach((width, index) => {
		requests.push({
			updateDimensionProperties: {
				range: {
					sheetId,
					dimension: 'COLUMNS',
					startIndex: index,
					endIndex: index + 1,
				},
				properties: { pixelSize: width },
				fields: 'pixelSize',
			},
		});
	});

	if (hasTeam) {
		requests.push(headerRowFormat(sheetId, 1, 4, HEADER_BG));
		requests.push({
			updateDimensionProperties: {
				range: {
					sheetId,
					dimension: 'ROWS',
					startIndex: 2,
					endIndex: 2 + team.length,
				},
				properties: { pixelSize: MON_ROW_HEIGHT },
				fields: 'pixelSize',
			},
		});
	}

	return { requests, battleHeaderRowIndex };
}

async function createTeamTab(
	tokenRef: TokenRef,
	spreadsheetId: string,
	tabName: string,
	team: TeamMon[],
	meta: SpreadsheetMeta,
): Promise<void> {
	// Add the tab and, for auto-created spreadsheets, drop the stray empty
	// default sheet in the same batch.
	const requests: unknown[] = [
		{ addSheet: { properties: { title: tabName } } },
	];
	const deletingDefault =
		meta.defaultSheetId != null && !meta.defaultSheetDeleted;
	if (deletingDefault) {
		requests.push({ deleteSheet: { sheetId: meta.defaultSheetId } });
	}

	const addRes = await sheetsCall(
		tokenRef,
		`${spreadsheetId}:batchUpdate`,
		'POST',
		{ requests },
	);
	// "Already exists" (400): the tab is there but we can't get its id, so just
	// leave it as-is (appends still work) without clobbering existing content.
	if (!addRes.ok) {
		if (addRes.status !== 400) await expectOk(addRes);
		return;
	}
	if (deletingDefault) meta.defaultSheetDeleted = true;

	const replies = (await addRes.json()) as {
		replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }>;
	};
	const sheetId = replies.replies?.[0]?.addSheet?.properties?.sheetId;

	await writeRange(
		tokenRef,
		spreadsheetId,
		tabName,
		teamHeaderRows(tabName, team),
	);

	if (sheetId != null) {
		const { requests: formatRequests } = tabFormatRequests(sheetId, team);
		await expectOk(
			await sheetsCall(tokenRef, `${spreadsheetId}:batchUpdate`, 'POST', {
				requests: formatRequests,
			}),
		);
	}
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

// Create a PokePaste of the opponent's revealed species (species-only, since
// their items/moves aren't known). Returns the paste URL, or '' on failure.
async function createPokepaste(
	species: string[],
	title: string,
): Promise<string> {
	if (species.length === 0) return '';
	const body = new URLSearchParams({
		paste: species.join('\n\n'),
		title,
		author: 'PASRS Helper',
	});
	try {
		// 303 redirect is followed automatically; response.url is the paste URL.
		const response = await fetch('https://pokepast.es/create', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
		});
		return response.ok ? response.url : '';
	} catch {
		return '';
	}
}

function buildBattleRow(
	payload: SheetsLogPayload,
	oppPokepaste: string,
): string[] {
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
		oppPokepaste,
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
		const allMeta = await getAllMeta();
		const spreadsheetId = await ensureSpreadsheetId(
			tokenRef,
			allMeta,
			data?.spreadsheetId,
		);

		const team = payload.myTeam ?? [];
		const key = speciesKeyOf(payload.myTeamSpecies ?? []);

		const meta = allMeta[spreadsheetId] ?? { teamCount: 0, teams: {} };
		let teamMeta = meta.teams[key];

		if (!teamMeta) {
			meta.teamCount += 1;
			const tabName = `Team ${meta.teamCount}`;
			await createTeamTab(tokenRef, spreadsheetId, tabName, team, meta);
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

		const opponent = payload.mySide === 'p2' ? payload.p1 : payload.p2;
		const oppPokepaste = await createPokepaste(
			payload.oppTeamSpecies ?? [],
			`${opponent} — ${payload.format}`,
		);

		await appendRows(tokenRef, spreadsheetId, teamMeta.tabName, [
			buildBattleRow(payload, oppPokepaste),
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
