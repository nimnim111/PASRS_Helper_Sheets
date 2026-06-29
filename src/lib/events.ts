import type { RoomReplay, TeamMon } from '../types/replay';
import type { Settings } from '../types/settings';

// Cross-context RPC (page <-> content script) for Google Sheets logging.
//
// The page-injected scripts (React panel, showdown hook) cannot use chrome.*,
// and OAuth + the Sheets API can only run in the background service worker.
// So requests hop: page --window.postMessage--> content script
// --chrome.runtime.sendMessage--> background, and the response travels back the
// same way. Each request carries a unique id so concurrent calls don't cross.
export const SHEETS_REQUEST = 'pasrs:sheets-request' as const;
export const SHEETS_RESPONSE = 'pasrs:sheets-response' as const;

export type SheetsAction =
	| 'auth'
	| 'signout'
	| 'status'
	| 'log'
	| 'spreadsheet';

export interface SheetsLogPayload {
	format: string;
	p1: string;
	p2: string;
	result: string;
	url: string;
	// Battle details (optional; absent for unrated/unknown data).
	mySide?: 'p1' | 'p2';
	myTeam?: TeamMon[];
	myTeamSpecies?: string[];
	oppTeamSpecies?: string[];
	myEloBefore?: string;
	myEloAfter?: string;
	myEloDelta?: string;
	oppElo?: string;
}

export interface SheetsRequestData {
	spreadsheetId?: string;
	sheetName?: string;
	payload?: SheetsLogPayload;
}

export interface SheetsRequestMessage {
	type: typeof SHEETS_REQUEST;
	requestId: string;
	action: SheetsAction;
	data?: SheetsRequestData;
}

export interface SheetsResponse {
	ok: boolean;
	error?: string;
	signedIn?: boolean;
	// The spreadsheet actually used/created (so the UI can link to it).
	spreadsheetId?: string;
	spreadsheetUrl?: string;
}

export interface SheetsResponseMessage extends SheetsResponse {
	type: typeof SHEETS_RESPONSE;
	requestId: string;
}

let sheetsRequestCounter = 0;

// Page-side: send a request to the background worker and await its response.
export const sheetsRequest = (
	action: SheetsAction,
	data?: SheetsRequestData,
	timeoutMs = 60000,
): Promise<SheetsResponse> => {
	const requestId = `${Date.now()}-${sheetsRequestCounter++}`;

	return new Promise((resolve) => {
		const cleanup = () => {
			window.removeEventListener('message', handler);
			clearTimeout(timer);
		};

		const handler = (event: MessageEvent) => {
			if (event.source !== window) return;
			const data = event.data as SheetsResponseMessage | undefined;
			if (
				!data ||
				data.type !== SHEETS_RESPONSE ||
				data.requestId !== requestId
			) {
				return;
			}
			cleanup();
			resolve({ ok: data.ok, error: data.error, signedIn: data.signedIn });
		};

		const timer = setTimeout(() => {
			cleanup();
			resolve({ ok: false, error: 'Request timed out' });
		}, timeoutMs);

		window.addEventListener('message', handler);

		const message: SheetsRequestMessage = {
			type: SHEETS_REQUEST,
			requestId,
			action,
			data,
		};
		window.postMessage(message, window.location.origin);
	});
};

// Content-script side: handle requests coming from the page and post results
// back. The handler typically forwards to the background service worker.
export const onSheetsRequest = (
	handler: (message: SheetsRequestMessage) => Promise<SheetsResponse>,
) => {
	const listener = (event: MessageEvent) => {
		if (event.source !== window) return;
		const data = event.data as SheetsRequestMessage | undefined;
		if (!data || data.type !== SHEETS_REQUEST) return;

		handler(data)
			.then((response) => sendSheetsResponse(data.requestId, response))
			.catch((error) =>
				sendSheetsResponse(data.requestId, {
					ok: false,
					error: String(error),
				}),
			);
	};
	window.addEventListener('message', listener);
	return () => window.removeEventListener('message', listener);
};

const sendSheetsResponse = (requestId: string, response: SheetsResponse) => {
	const message: SheetsResponseMessage = {
		type: SHEETS_RESPONSE,
		requestId,
		...response,
	};
	window.postMessage(message, window.location.origin);
};

export const EVENTS = {
	FORMATS_UPDATED: 'pasrs:formats-updated',
	SETTINGS_UPDATED: 'pasrs:settings-updated',
	REPLAYS_UPDATED: 'pasrs:replays-updated',
} as const;

export interface FormatsUpdatedEvent extends CustomEvent {
	detail: {
		formats: string[];
	};
}

export interface SettingsUpdatedEvent extends CustomEvent {
	detail: {
		settings: Settings;
	};
}

export interface ReplaysUpdatedEvent extends CustomEvent {
	detail: {
		replays: RoomReplay[];
	};
}

// Helper functions for dispatching events
export const dispatchFormatsUpdated = (formats: string[]) => {
	const event = new CustomEvent(EVENTS.FORMATS_UPDATED, {
		detail: { formats },
	});
	window.dispatchEvent(event);
};

export const dispatchSettingsUpdated = (settings: Settings) => {
	const event = new CustomEvent(EVENTS.SETTINGS_UPDATED, {
		detail: { settings },
	});
	window.dispatchEvent(event);
};

export const dispatchReplaysUpdated = (replays: RoomReplay[]) => {
	const event = new CustomEvent(EVENTS.REPLAYS_UPDATED, {
		detail: { replays },
	});
	window.dispatchEvent(event);
};

// Helper functions for listening to events
export const onFormatsUpdated = (callback: (formats: string[]) => void) => {
	const handler = (event: FormatsUpdatedEvent) => {
		callback(event.detail.formats);
	};
	window.addEventListener(EVENTS.FORMATS_UPDATED, handler as EventListener);
	return () =>
		window.removeEventListener(
			EVENTS.FORMATS_UPDATED,
			handler as EventListener,
		);
};

export const onSettingsUpdated = (callback: (settings: Settings) => void) => {
	const handler = (event: SettingsUpdatedEvent) => {
		callback(event.detail.settings);
	};
	window.addEventListener(EVENTS.SETTINGS_UPDATED, handler as EventListener);
	return () =>
		window.removeEventListener(
			EVENTS.SETTINGS_UPDATED,
			handler as EventListener,
		);
};

export const onReplaysUpdated = (callback: (replays: RoomReplay[]) => void) => {
	const handler = (event: ReplaysUpdatedEvent) => {
		callback(event.detail.replays);
	};
	window.addEventListener(EVENTS.REPLAYS_UPDATED, handler as EventListener);
	return () =>
		window.removeEventListener(
			EVENTS.REPLAYS_UPDATED,
			handler as EventListener,
		);
};
