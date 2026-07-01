import { ReplayRoomState } from '../../types/replay';
import {
	getFormatFromData,
	getRoomIdFromData,
	getRoomIdFromURL,
	getUrlFromData,
	getUserFromCookies,
} from '../../utils/showdown-data-utils';
import {
	isBattleFormatMessage,
	isBattleInitMessage,
	isForfeitCommand,
	isFormatMessage,
	isLeaveViewCommand,
	isReplayUploadedMessage,
	isWinMessage,
} from '../../utils/showdown-protocol-utils';
import { copyToClipboardWithRetry } from '../browser/browser';
import { onSettingsUpdated, sheetsRequest } from '../events';
import { getTeamCandidates } from '../../utils/showdown-teams';
import { ReplaysManager } from '../storage/replays-manager';
import { SettingsManager } from '../storage/settings-manager';
import createPASRSRoom from './pasrs_room';
import type { App } from './room';

declare const app: App;

const appReceive = app.receive.bind(app);
const appSend = app.send.bind(app);
const settingsManager = SettingsManager.getInstance();
const replaysManager = new ReplaysManager();

let currentSettings = settingsManager.getSettings();

// Best-effort desktop notification (used to surface Google Sheets sync results
// so a failed/misrouted write isn't silent).
function notify(message: string): void {
	try {
		if (typeof Notification !== 'undefined') {
			new Notification(message);
		}
	} catch {
		// Notifications may be unavailable/denied; ignore.
	}
}

onSettingsUpdated((settings) => {
	currentSettings = settings;
});

app.receive = (data: string) => {
	var settings = currentSettings;

	if (isFormatMessage(data)) {
		settingsManager.setCustomFormats(getFormatFromData(data));
	}

	if (!settings.active) {
		appReceive(data);
		return;
	}

	if (isBattleInitMessage(data)) {
		replaysManager.addReplay(data);
	}
	if (isBattleFormatMessage(data)) {
		replaysManager.updateFormatReplay(data);
	}

	if (settings.vgc_only || settings.use_custom_replay_filter) {
		const roomId = getRoomIdFromData(data);
		const room = replaysManager.getReplay(roomId);

		if (settings.vgc_only) {
			if (room && room.format && !room.format.toLowerCase().includes('vgc')) {
				replaysManager.setRoomState(roomId, ReplayRoomState.Ignored);
			}
		} else if (settings.use_custom_replay_filter) {
			var formats = settings.custom_replay_filter;
			if (
				room &&
				room.format &&
				formats?.length > 0 &&
				!formats.some(
					(format) => room.format?.toLowerCase() === format.toLowerCase(),
				)
			) {
				replaysManager.setRoomState(roomId, ReplayRoomState.Ignored);
			}
		}
	}

	if (isWinMessage(data)) {
		const roomId = getRoomIdFromData(data);
		const roomState = replaysManager.getRoomState(roomId);
		if (
			roomState === ReplayRoomState.OnGoing ||
			roomState === ReplayRoomState.Forfeited
		) {
			replaysManager.setRoomResult(roomId, data);

			if (roomState !== ReplayRoomState.Forfeited) {
				app.send('/savereplay', roomId);
			}
		}
	}

	if (isReplayUploadedMessage(data)) {
		const url = getUrlFromData(data);
		const roomId = getRoomIdFromURL(url);

		if (replaysManager.getRoomState(roomId) !== ReplayRoomState.Recorded) {
			replaysManager.updateReplayUrl(roomId, url);

			if (replaysManager.getRoomState(roomId) === ReplayRoomState.Finished) {
				if (settings.use_clipboard) {
					copyToClipboardWithRetry(url, settings.notifications);
				}

				if (settings.log_to_sheets) {
					let availableTeams: ReturnType<typeof getTeamCandidates> = [];
					try {
						availableTeams = getTeamCandidates();
					} catch {
						availableTeams = [];
					}
					sheetsRequest('log', {
						spreadsheetId: settings.sheets_spreadsheet_id,
						payload: { url, playerName: getUserFromCookies() ?? '' },
						availableTeams,
					}).then((response) => {
						if (response.ok) {
							if (settings.notifications) {
								notify('Game added to your PASRS tracker');
							}
						} else {
							console.error(
								'PASRS Helper: failed to log replay to Google Sheets',
								response.error,
							);
							// Always surface a sheet failure — otherwise it's silent and
							// the tracker just looks like it isn't updating.
							const message = (response.error ?? '').includes(
								'context invalidated',
							)
								? 'PASRS: reload the Showdown page to reconnect (extension was updated).'
								: `PASRS: couldn't update sheet — ${response.error}`;
							notify(message);
						}
					});
				}

				replaysManager.setRoomState(roomId, ReplayRoomState.Recorded);
				return;
			}
		}
	}

	appReceive(data);
};

app.send = (data: string, roomId?: string) => {
	const settings = currentSettings;

	appSend(data, roomId);
	if (
		settings.active &&
		isForfeitCommand(data) &&
		roomId &&
		replaysManager.getRoomState(roomId) === ReplayRoomState.OnGoing
	) {
		replaysManager.setRoomState(roomId, ReplayRoomState.Forfeited);
		appSend('/savereplay', roomId);
	}
	if (isLeaveViewCommand(data)) {
		setTimeout(createPASRSRoom, 0);
	}
};

// poor mans await.
// Indeed :(
let roomTimer = setTimeout(function roomCreator() {
	if (window.app) {
		clearTimeout(roomTimer);
		createPASRSRoom();
	} else {
		roomTimer = setTimeout(roomCreator, 250);
	}
}, 0);
