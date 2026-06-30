// Faithful TypeScript port of the PASRS 7 `REPLAYTODATA` Apps Script function.
// The template's dashboards are driven by plain spreadsheet formulas that read
// a per-game "spill" row out of the `Base Data` sheet.
//
// Output column order (matches PASRS 7 Base Data layout, starting at col B):
//   B            p1
//   C..H         team1[0..5]
//   I            p2
//   J..O         team2[0..5]
//   P            winner (1 or 2)
//   Q..T         p1MegaMon, "", p2MegaMon, "" (Champions format — no Tera)
//   U..X         team1leads[0..1], team2leads[0..1]
//   Y            "ots" | "cts"
//   Z..AC        p1StartELO, p2StartELO, p1EndELO, p2EndELO
//   AD..AG       bo3("true"|""), setGameCount, lastGame("yes"/"no"|""), timestamp
//   AH..AM       "p1: 0", alignLeft, "vs", alignRight, "p2: 0", url
//   AN..AQ       team1used[0..3]
//   AR..AU       team2used[0..3]
//   AV..         "P1 MOVES START", p1 combos…, "P1 MOVES END",
//                "P2 MOVES START", p2 combos…, "P2 MOVES END"

type Cell = string | number;

interface ReplayJson {
	uploadtime?: number;
	log: string;
	format?: string;
}

class MoveCount {
	moveName: string;
	moveCount = 1;
	constructor(moveName: string) {
		this.moveName = moveName;
	}
	addOne(): void {
		this.moveCount++;
	}
}

class PokemonMoveListing {
	pokemonName: string;
	moveCounts: MoveCount[] = [];
	constructor(name: string) {
		this.pokemonName = name;
	}
	useMove(move: string): void {
		const existing = this.moveCounts.find((m) => m.moveName === move);
		if (existing) existing.addOne();
		else this.moveCounts.push(new MoveCount(move));
	}
}

class MoveManager {
	playerMoveListings: PokemonMoveListing[] = [];
	addMove(mon: string, move: string): void {
		const existing = this.playerMoveListings.find((l) => l.pokemonName === mon);
		if (existing) existing.useMove(move);
		else {
			const listing = new PokemonMoveListing(mon);
			listing.useMove(move);
			this.playerMoveListings.push(listing);
		}
	}
}

interface Nickname {
	realName: string;
	nickname: string;
}

function fixSpecialChars(text: string): string {
	return text
		.replace(/&#39;/g, "'")
		.replace(/&#34;/g, '"')
		.replace(/&amp;/g, '&')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&apos;/g, "'");
}

function normaliseSwitchName(name: string): string {
	let mon = name;
	if (mon === 'Palafin-Hero') mon = 'Palafin';
	if (mon === 'Terapagos-Terastal' || mon === 'Terapagos-Stellar') mon = 'Terapagos';
	if (mon.includes('-Teal-Tera')) mon = 'Ogerpon';
	if (mon.includes('-Tera')) mon = mon.replace('-Tera', '');
	if (mon.includes('-Mega-Y')) mon = mon.replace('-Mega-Y', '');
	if (mon.includes('-Mega-X')) mon = mon.replace('-Mega-X', '');
	if (mon.includes('-Mega')) mon = mon.replace('-Mega', '');
	return mon;
}

export function replayToData(url: string, jsonText: string): Cell[] {
	let replayUrl = url;
	if (replayUrl.slice(-3) === '?p2') replayUrl = replayUrl.slice(0, -3);

	const replay = JSON.parse(jsonText) as ReplayJson;
	const gameLog = (replay.log ?? '').split('\n');
	const format = replay.format ?? '';
	const timestamp = replay.uploadtime;

	let ladder = false;
	let ots = false;
	let numPlayersAgreeToOTS = 0;
	let hasELO = false;

	let setGameCount = '';
	const setP1winCount = 0;
	const setP2winCount = 0;
	let advantagePlayer = '';
	let lastGameOfSet = false;

	let p1 = '';
	let p2 = '';
	let p1StartELO: string | undefined;
	let p1EndELO: string | undefined;
	let p2StartELO: string | undefined;
	let p2EndELO: string | undefined;

	let alignLeftPlayer: string | undefined;
	let alignRightPlayer: string | undefined;

	const team1: string[] = [];
	const team2: string[] = [];
	const team1leads: string[] = [];
	const team2leads: string[] = [];
	const team1used: string[] = [];
	const team2used: string[] = [];
	const team1nicknames: Nickname[] = [];
	const team2nicknames: Nickname[] = [];

	// Tera vars kept for tracking but not output in PASRS 7
	let p1TeraMon: string | undefined;
	let p2TeraMon: string | undefined;
	let p1TeraType: string | undefined;
	let p2TeraType: string | undefined;

	let p1MegaMon: string | undefined;
	let p2MegaMon: string | undefined;

	const p1Moves = new MoveManager();
	const p2Moves = new MoveManager();

	let winoutp: number | undefined;

	for (let logIndex = 0; logIndex < gameLog.length; logIndex++) {
		const line = gameLog[logIndex];
		const tokens = line.split('|');

		if (tokens[1] === 'html' && tokens[2]?.startsWith('<table width=')) {
			alignLeftPlayer = tokens[2].split('<td align="left">')[1]?.split('</td>')[0];
			alignRightPlayer = tokens[2].split('<td align="right">')[1]?.split('</tr>')[0];
			if (alignLeftPlayer && alignRightPlayer) {
				const afterRight = tokens[2].split(alignRightPlayer)[1] ?? '';
				const parts = afterRight.split('align="right"');
				if (parts[0]?.includes('"fa fa-circle"')) advantagePlayer = alignLeftPlayer;
				if (parts[1]?.includes('"fa fa-circle"')) advantagePlayer = alignRightPlayer;
			}
		}

		if (tokens[1] === 'uhtml' && tokens[2] === 'bestof') {
			setGameCount = tokens[3]?.charAt(17) ?? '';
			if (setGameCount === '3') lastGameOfSet = true;
		}

		if (tokens[1] === 'player') {
			if (tokens[2] === 'p1' && p1 === '') p1 = tokens[3];
			else if (tokens[2] === 'p2' && p2 === '') p2 = tokens[3];
		}

		if (tokens[1] === 'poke') {
			if (tokens[2] === 'p1') team1.push(tokens[3].split(',')[0]);
			else if (tokens[2] === 'p2') team2.push(tokens[3].split(',')[0]);
		}

		if (tokens[1] === 'switch' || tokens[1] === 'drag') {
			const idstuff = tokens[2].split(': ');
			const tempNickname = idstuff[1];
			const monTempName = normaliseSwitchName(tokens[3].split(',')[0]);
			const newNick: Nickname = { realName: monTempName, nickname: tempNickname };

			if (idstuff[0].includes('1')) {
				if (team1leads.length < 2 && !team1leads.includes(monTempName))
					team1leads.push(monTempName);
				if (!team1used.includes(monTempName)) {
					team1used.push(monTempName);
					team1nicknames.push(newNick);
				}
			}
			if (idstuff[0].includes('2')) {
				if (team2leads.length < 2 && !team2leads.includes(monTempName))
					team2leads.push(monTempName);
				if (!team2used.includes(monTempName)) {
					team2used.push(monTempName);
					team2nicknames.push(newNick);
				}
			}
		}

		if (tokens[1] === '-terastallize') {
			const idstuff = tokens[2].split(': ');
			if (idstuff[0].includes('1')) {
				for (const nick of team1nicknames) {
					if (idstuff[1] === nick.nickname) {
						p1TeraMon = nick.realName;
						p1TeraType = tokens[3];
					}
				}
			}
			if (idstuff[0].includes('2')) {
				for (const nick of team2nicknames) {
					if (idstuff[1] === nick.nickname) {
						p2TeraMon = nick.realName;
						p2TeraType = tokens[3];
					}
				}
			}
		}

		if (tokens[1] === '-mega') {
			const idstuff = tokens[2].split(': ');
			const monNick = idstuff[1];
			const stone = tokens[4] ?? '';
			let stoneSuffix = '';
			if (stone.endsWith('X')) stoneSuffix = '-X';
			if (stone.endsWith('Y')) stoneSuffix = '-Y';

			if (idstuff[0].includes('1')) {
				for (const nick of team1nicknames) {
					if (monNick === nick.nickname) {
						p1MegaMon = nick.realName + stoneSuffix + '-Mega';
					}
				}
			}
			if (idstuff[0].includes('2')) {
				for (const nick of team2nicknames) {
					if (monNick === nick.nickname) {
						p2MegaMon = nick.realName + stoneSuffix + '-Mega';
					}
				}
			}
		}

		if (tokens[1] === 'move') {
			const idstuff = tokens[2].split(':');
			const moveUser = tokens[2].split(': ')[1];
			const moveName = tokens[3];
			if (idstuff[0].includes('1')) p1Moves.addMove(moveUser, moveName);
			if (idstuff[0].includes('2')) p2Moves.addMove(moveUser, moveName);
		}

		// Illusion (Zoroark): rewind to the prior -damage line to recover the
		// decoy's identity, then swap the revealed mon into leads/used.
		if (tokens[1] === 'replace') {
			const monid = tokens[2].split(':')[0];
			const illusionFormalName = tokens[3].split(',')[0];
			let matchfound = false;
			let newLogIndex = logIndex;
			while (!matchfound && newLogIndex > 0) {
				newLogIndex--;
				const previousTokens = gameLog[newLogIndex].split('|');
				if (
					previousTokens[1] === '-damage' &&
					monid === previousTokens[2].split(':')[0]
				) {
					const decoyNick = previousTokens[2].split(': ')[1];
					matchfound = true;
					if (monid.includes('1')) {
						for (const nick of team1nicknames) {
							if (decoyNick === nick.nickname) {
								const decoyMon = nick.realName;
								const leadIndex = team1leads.indexOf(decoyMon);
								if (leadIndex > -1) {
									team1leads.splice(leadIndex, 1);
									team1leads.push(illusionFormalName);
									team1used.push(decoyMon);
								} else if (team1used.includes(decoyMon)) {
									team1used.push(illusionFormalName);
								}
							}
						}
					}
					if (monid.includes('2')) {
						for (const nick of team2nicknames) {
							if (decoyNick === nick.nickname) {
								const decoyMon = nick.realName;
								const leadIndex = team2leads.indexOf(decoyMon);
								if (leadIndex > -1) {
									team2leads.splice(leadIndex, 1);
									team2leads.push(illusionFormalName);
									team2used.push(decoyMon);
								} else if (team2used.includes(decoyMon)) {
									team2used.push(illusionFormalName);
								}
							}
						}
					}
				}
			}
		}

		if (tokens[1] === 'win') {
			const winner = tokens[2];
			winoutp = winner === p1 ? 1 : 2;
			if (winner === advantagePlayer) lastGameOfSet = true;
		}
		if (tokens[1] === 'rated') ladder = true;
		if (tokens[1] === 'raw') {
			const tempSplit = tokens[2].split("'s rating: ");
			if (tempSplit.length > 1) {
				hasELO = true;
				const ratedPlayer = fixSpecialChars(tempSplit[0]);
				const startRating = tempSplit[1].split(' ')[0];
				const endRating = tokens[2].split('<strong>')[1].split('<')[0];
				if (ratedPlayer === p1) {
					p1StartELO = startRating;
					p1EndELO = endRating;
				} else if (ratedPlayer === p2) {
					p2StartELO = startRating;
					p2EndELO = endRating;
				}
			}
		}
		if (line.includes('has agreed to open team sheets')) numPlayersAgreeToOTS++;
	}

	if (numPlayersAgreeToOTS === 2) ots = true;
	const bo3 = format.includes('(Bo3)');
	if (bo3 && ladder) ots = true;

	// suppress unused-variable warnings — Tera tracked but Champions format outputs
	// Mega in Q-T (the REPLAYTODATA Tera push is commented out in the Apps Script)
	void p1TeraMon;
	void p1TeraType;
	void p2TeraMon;
	void p2TeraType;

	const output: Array<Cell | undefined> = [];

	output.push(p1);
	for (let i = 0; i < 6; i++) output.push(team1[i]);
	output.push(p2);
	for (let i = 0; i < 6; i++) output.push(team2[i]);
	output.push(winoutp);

	// Q-T: Mega slots (matches REPLAYTODATA — p1Mega, "", p2Mega, "")
	output.push(p1MegaMon);
	output.push('');
	output.push(p2MegaMon);
	output.push('');

	output.push(team1leads[0]);
	output.push(team1leads[1]);
	output.push(team2leads[0]);
	output.push(team2leads[1]);

	output.push(ots ? 'ots' : 'cts');

	if (hasELO) {
		output.push(p1StartELO, p2StartELO, p1EndELO, p2EndELO);
	} else if (ladder) {
		output.push('?', '?', '?', '?');
	} else if (!ladder) {
		output.push('---', '---', '---', '---');
	} else {
		output.push('', '', '', '');
	}

	// AD-AG: Bo3 metadata
	if (bo3) {
		output.push('true');
		output.push(setGameCount);
		if (hasELO) lastGameOfSet = true;
		output.push(lastGameOfSet ? 'yes' : 'no');
		output.push(timestamp);
	} else {
		output.push('', '', '', '');
	}

	// AH-AM: score placeholders + replay URL
	output.push(`p1: ${setP1winCount}`);
	output.push(alignLeftPlayer);
	output.push('vs');
	output.push(alignRightPlayer);
	output.push(`p2: ${setP2winCount}`);
	output.push(replayUrl);

	output.push(team1used[0], team1used[1], team1used[2], team1used[3]);
	output.push(team2used[0], team2used[1], team2used[2], team2used[3]);

	output.push('P1 MOVES START');
	for (const listing of p1Moves.playerMoveListings) {
		for (const mc of listing.moveCounts) {
			output.push(`${listing.pokemonName}:${mc.moveName}:${mc.moveCount}`);
		}
	}
	output.push('P1 MOVES END');
	output.push('P2 MOVES START');
	for (const listing of p2Moves.playerMoveListings) {
		for (const mc of listing.moveCounts) {
			output.push(`${listing.pokemonName}:${mc.moveName}:${mc.moveCount}`);
		}
	}
	output.push('P2 MOVES END');

	return output.map((cell) => cell ?? '');
}

export function replayJsonUrl(url: string): string {
	let replayUrl = url;
	if (replayUrl.slice(-3) === '?p2') replayUrl = replayUrl.slice(0, -3);
	return `${replayUrl}.json`;
}
