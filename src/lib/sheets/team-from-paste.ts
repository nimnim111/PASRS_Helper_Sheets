// Faithful TypeScript port of the PASRS template's `TEAMDATAFROMPASTE` Apps
// Script function. The "Usage Stats" dashboard reads the player's own team out
// of the `Team Info From Paste` sheet, normally filled by
// `=TRANSPOSE(TEAMDATAFROMPASTE(Paste))`. Like REPLAYTODATA this custom function
// is lost on xlsx export, so the extension reproduces its output and writes it
// down column A; the sheet's TRIM/VLOOKUP formulas then render the page.
//
// Output order (written down column A, A1 first), matching the formulas that
// read it (name → A1, moves → A2..A5, tera (mon 1) → A31, nickname → A37):
//   for each mon: name, move1, move2, move3, move4
//   then every tera type
//   then every nickname
//   then the team title
//
// The input is the raw HTML of a pokepaste page (e.g. https://pokepast.es/xxxx).

interface PasteMon {
	name: string;
	nickname: string;
	tera: string;
	moves: [string, string, string, string];
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

const TERA_TYPES = [
	'normal',
	'fighting',
	'flying',
	'poison',
	'ground',
	'rock',
	'bug',
	'ghost',
	'steel',
	'fire',
	'water',
	'grass',
	'electric',
	'psychic',
	'ice',
	'dragon',
	'dark',
	'fairy',
	'stellar',
	'Stellar',
];

// Recovers a tera type from text whose `type-…` span is missing.
function correctTeraType(rawText: string): string {
	for (const tera of TERA_TYPES) {
		if (rawText.includes(tera)) {
			return tera.charAt(0).toUpperCase() + tera.slice(1);
		}
	}
	return rawText;
}

const MOVE_EXCEPTIONS = [
	'Matcha Gotcha',
	'Blood Moon',
	'Ivy Cudgel',
	'Syrup Bomb',
	'Electro Shot',
	'Thunderclap',
	'Tachyon Cutter',
	'Mighty Cleave',
	'Psyblade',
	'Hydro Steam',
	'Supercell Slam',
	'Burning Bulwark',
	'Hard Press',
	'Fickle Beam',
	'Tera Starstorm',
	'Dragon Cheer',
	'Alluring Voice',
	'Temper Flare',
	'Psychic Noise',
	'Upper Hand',
	'Malignant Chain',
];

// Pokepaste doesn't wrap a handful of newer moves in a span; re-insert the
// markup the parser keys off of.
function patchMoveExceptions(rawText: string): string {
	let returnText = rawText;
	for (const move of MOVE_EXCEPTIONS) {
		returnText = returnText.replace(
			move,
			`<span class="type-grass">-</span> ${move}  \n`,
		);
	}
	return returnText;
}

const MON_EXCEPTIONS = [
	'Munkidori',
	'Okidogi',
	'Fezandipiti',
	'Dipplin',
	'-Bloodmoon',
	'-Hisui',
	'-Cornerstone',
	'-Wellspring',
	'-Hearthflame',
	'-Artisan',
	'-Masterpiece',
	'Overqwil',
	'Walking Wake',
	'Iron Leaves',
	'Archaludon',
	'Raging Bolt',
	'Hydrapple',
	'Gouging Fire',
	'Iron Boulder',
	'Iron Crown',
	'Terapagos',
	'Pecharunt',
];

function patchMonExceptions(rawText: string): string {
	let returnText = rawText;
	const firstSplit = returnText.split('</span>')[0];
	for (const mon of MON_EXCEPTIONS) {
		if (firstSplit.includes(mon)) {
			returnText = `<span class="type-grass">${returnText.replace(
				mon,
				`${mon}</span>`,
			)}`;
		}
	}
	return returnText;
}

export function teamFromPaste(html: string): string[] {
	const team: PasteMon[] = [];
	const teamTitle = html.split('</title>')[0].split('<title>')[1] ?? '';
	const monSplit = html.split('<pre>');

	for (let monIndex = 1; monIndex < monSplit.length; monIndex++) {
		let monException = false;
		let currentMonLine = patchMonExceptions(monSplit[monIndex]);
		if (currentMonLine !== monSplit[monIndex]) monException = true;

		const beforeSpan = () => currentMonLine.split('</span>')[0];
		const wrap = (token: string, type: string) => {
			currentMonLine = `<span class="type-${type}">${currentMonLine.replace(
				token,
				`${token}</span>`,
			)}`;
			monException = true;
		};

		if (
			beforeSpan().includes('Sinistcha') &&
			!beforeSpan().includes('Sinistcha-')
		)
			wrap('Sinistcha', 'grass');
		if (
			beforeSpan().includes('Poltchageist') &&
			!beforeSpan().includes('Poltchageist-')
		)
			wrap('Poltchageist', 'grass');
		if (beforeSpan().includes('Alcremie-') && beforeSpan().includes('-Cream'))
			wrap('Cream', 'fairy');
		if (beforeSpan().includes('Alcremie-') && beforeSpan().includes('-Swirl'))
			wrap('Swirl', 'fairy');
		if (beforeSpan().includes('Ogerpon') && !beforeSpan().includes('Ogerpon-'))
			wrap('Ogerpon', 'grass');

		const monHeader = currentMonLine.split('</span>')[0];
		let tempName = monHeader.split('>')[1];
		let tempNick =
			currentMonLine.charAt(0) === '<'
				? monHeader.split('>')[1]
				: monHeader.split(' (<span')[0];

		if (monException) {
			const garbo = tempName;
			if (garbo.includes(' (')) {
				tempName = garbo.split(' (')[1];
				tempNick = garbo.split(' (')[0];
			}
		}
		tempNick = fixSpecialChars(tempNick);

		// Tera type — handle both the well-formed span and the broken variant.
		const teraCorrectionInfo = currentMonLine.split(
			'<span class="attr">Tera Type: </span>',
		)[1];
		let teraType: string;
		if (teraCorrectionInfo === undefined) {
			// Some pastes omit a Tera Type entirely.
			teraType = '';
		} else if (teraCorrectionInfo.charAt(0) === '<') {
			const teraSplitInfo = currentMonLine.split(
				'<span class="attr">Tera Type: </span><span class="type-',
			);
			teraType = teraSplitInfo[1].split('>')[1].split('<')[0];
		} else {
			teraType = correctTeraType(teraCorrectionInfo.split('<')[0]);
		}

		const moveFixText = patchMoveExceptions(currentMonLine);
		const moveSplits = moveFixText.split('">-</span> ');
		const moveAt = (i: number): string =>
			i in moveSplits ? moveSplits[i].split('\n')[0] : '';
		let m1 = moveAt(1);
		let m2 = moveAt(2);
		let m3 = moveAt(3);
		let m4 = moveAt(4);

		const fixSignatureMove = (replacement: string) => {
			if (m1.includes('Iron Head')) m1 = replacement;
			if (m2.includes('Iron Head')) m2 = replacement;
			if (m3.includes('Iron Head')) m3 = replacement;
			if (m4.includes('Iron Head')) m4 = replacement;
		};
		if (tempName === 'Zacian-Crowned') fixSignatureMove('Behemoth Blade');
		if (tempName === 'Zamazenta-Crowned') fixSignatureMove('Behemoth Bash');

		team.push({
			name: tempName,
			nickname: tempNick,
			tera: teraType,
			moves: [m1, m2, m3, m4],
		});
	}

	const output: string[] = [];
	const teras: string[] = [];
	for (const mon of team) {
		output.push(mon.name);
		teras.push(mon.tera);
		output.push(mon.moves[0], mon.moves[1], mon.moves[2], mon.moves[3]);
	}
	for (const tera of teras) output.push(tera);
	for (const mon of team) output.push(mon.nickname);
	output.push(teamTitle);
	return output;
}
