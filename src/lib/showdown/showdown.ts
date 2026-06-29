import { ReplayRoomState } from '../../types/replay';
import {
	isPlayerMessage,
	isRatingMessage,
	isRequestMessage,
	isTeamPreviewMessage,
	parseOpponentSpecies,
	parsePlayers,
	parseRatingChange,
	parseRequestTeam,
} from '../../utils/showdown-battle-utils';
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

onSettingsUpdated((settings) => {
	currentSettings = settings;
});

// Accumulate team / rating details from the battle protocol stream onto the
// tracked replay, so they can be logged to Sheets when the replay is recorded.
function collectBattleDetails(data: string): void {
	const roomId = getRoomIdFromData(data);
	if (!roomId || !replaysManager.hasRoom(roomId)) return;

	if (isPlayerMessage(data)) {
		const players = parsePlayers(data);
		const user = getUserFromCookies();
		let mySide: 'p1' | 'p2' | undefined;
		if (user) {
			if (players.p1.name?.toLowerCase() === user.toLowerCase()) mySide = 'p1';
			else if (players.p2.name?.toLowerCase() === user.toLowerCase())
				mySide = 'p2';
		}
		replaysManager.mergeReplay(roomId, {
			mySide,
			p1Elo: players.p1.rating,
			p2Elo: players.p2.rating,
		});
	}

	if (isRequestMessage(data)) {
		const parsed = parseRequestTeam(data);
		if (parsed) {
			replaysManager.mergeReplay(roomId, {
				mySide: parsed.side,
				myTeam: parsed.team,
				myTeamSpecies: parsed.species,
			});
		}
	}

	if (isTeamPreviewMessage(data)) {
		const replay = replaysManager.getReplay(roomId);
		if (replay?.mySide) {
			const oppSide = replay.mySide === 'p1' ? 'p2' : 'p1';
			const species = parseOpponentSpecies(data, oppSide);
			if (species.length > 0) {
				replaysManager.mergeReplay(roomId, { oppTeamSpecies: species });
			}
		}
	}

	if (isRatingMessage(data)) {
		const user = getUserFromCookies();
		if (user) {
			const change = parseRatingChange(data, user);
			if (change) {
				replaysManager.mergeReplay(roomId, {
					myEloBefore: change.before,
					myEloAfter: change.after,
					myEloDelta: change.delta,
				});
			}
		}
	}
}

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

	collectBattleDetails(data);

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
					const replay = replaysManager.getReplay(roomId);
					if (replay) {
						const oppElo = replay.mySide === 'p2' ? replay.p1Elo : replay.p2Elo;
						const myEloBefore =
							replay.myEloBefore ??
							(replay.mySide === 'p2' ? replay.p2Elo : replay.p1Elo);
						sheetsRequest('log', {
							spreadsheetId: settings.sheets_spreadsheet_id,
							sheetName: settings.sheets_sheet_name,
							payload: {
								format: replay.format ?? '',
								p1: replay.p1,
								p2: replay.p2,
								result: replay.result,
								url: replay.url,
								mySide: replay.mySide,
								myTeam: replay.myTeam,
								myTeamSpecies: replay.myTeamSpecies,
								oppTeamSpecies: replay.oppTeamSpecies,
								myEloBefore,
								myEloAfter: replay.myEloAfter,
								myEloDelta: replay.myEloDelta,
								oppElo,
							},
						}).then((response) => {
							if (!response.ok) {
								console.error(
									'PASRS Helper: failed to log replay to Google Sheets',
									response.error,
								);
							}
						});
					}
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
