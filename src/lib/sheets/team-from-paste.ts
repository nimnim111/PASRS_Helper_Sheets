// Faithful TypeScript port of the PASRS 7 `importteam` Apps Script function
// (the one bound to `Team Info From Paste!A1` via `=importteam(Paste)`).
//
// It parses the raw Showdown paste text from a pokepaste's `/json` endpoint and
// writes, down column A, 10 values per mon in this order:
//   nickname-or-name, name, item, ability, tera, move1, move2, move3, move4, evs
// (up to 6 mons). The sheet's TRIM/VLOOKUP formulas in columns C..S then read
// those cells at fixed offsets, so the order/count must match exactly.
//
// The input is the text body of `https://pokepast.es/xxxx/json`, whose `paste`
// field contains the Showdown export with literal `\r\n` line breaks.

interface PasteMon {
	name: string;
	nickname: string;
	item: string;
	ability: string;
	tera: string;
	moves: [string, string, string, string];
	evs: string;
}

function fixUnicodeChars(text: string): string {
	return text
		.replace(/\\u2019/g, "'")
		.replace(/\\u0022/g, '"')
		.replace(/\\u0026/g, '&')
		.replace(/\\u003e/g, '>')
		.replace(/\\u003c/g, '<')
		.replace(/\\u0027/g, "'");
}

// Mirrors getPokemonName: strips gender tags, item, nickname parens, and
// unifies a few species Showdown names differently from the template.
function getPokemonName(currentmon: string): string {
	let name = currentmon;
	if (name.includes('(M)')) name = name.replace(/ \(M\)/g, '');
	else if (name.includes('(F)')) name = name.replace(/ \(F\)/g, '');
	if (name.includes('\\r\\n')) name = name.replace(/\\r\\n/g, '');

	if (name.includes(' @')) name = name.split(' @')[0];
	else name = name.split(' Ability')[0];

	if (name.includes('(')) name = name.split('(')[1].split(')')[0];

	if (name.includes('Terapagos')) return 'Terapagos';
	if (name.includes('Zamazenta')) return 'Zamazenta-Crowned';
	if (name.includes('Zacian')) return 'Zacian-Crowned';
	if (name.includes('Palafin')) return 'Palafin';

	return name.trim();
}

function getNickname(currentmon: string): string {
	let nick = currentmon.split('\\r\\n')[0];
	nick = nick.replace(/\(M\)/g, '').replace(/\(F\)/g, '');
	if (!nick.includes('(')) return '';
	return fixUnicodeChars(nick.split('(')[0].trim());
}

function getItem(currentmon: string): string {
	const beforeTera = currentmon.split('Tera: ')[0];
	if (beforeTera.includes('@ ')) {
		return beforeTera.split('@ ')[1]?.split('\\r\\n')[0].trim() ?? '';
	}
	return '';
}

function getTera(currentmon: string): string {
	return currentmon.split('Tera Type: ')[1]?.split('\\r\\n')[0].trim() ?? '';
}

function getAbility(currentmon: string): string {
	return currentmon.split('Ability: ')[1]?.split('\\r\\n')[0].trim() ?? '';
}

function getEvs(currentmon: string): string {
	return currentmon.split('EVs: ')[1]?.split('\\r\\n')[0].trim() ?? '';
}

function getMoves(currentmon: string): string[] {
	const moves = currentmon.split('\\r\\n- ');
	if (moves[4] !== undefined) moves[4] = moves[4].replace(/\\r\\n/g, '');
	return moves;
}

// Input is the text of the pokepaste `/json` response.
export function teamFromPaste(jsonText: string): string[] {
	// The `paste` field holds the raw Showdown export; mons are separated by a
	// blank line (`\r\n\r\n` in the escaped JSON text).
	const paste = jsonText.split('paste":"')[1]?.split('","title":')[0] ?? '';
	let monsplit = paste.split('\\r\\n\\r\\n');
	if (monsplit[0] === '') monsplit = monsplit.slice(1);

	const team: PasteMon[] = [];
	for (const currentmon of monsplit) {
		if (!currentmon.trim()) continue;
		const moves = getMoves(currentmon);
		team.push({
			name: getPokemonName(currentmon),
			nickname: getNickname(currentmon),
			item: getItem(currentmon),
			ability: getAbility(currentmon),
			tera: getTera(currentmon),
			moves: [moves[1] ?? '', moves[2] ?? '', moves[3] ?? '', moves[4] ?? ''],
			evs: getEvs(currentmon),
		});
	}

	// Mirrors outputTeam: 10 values per mon (up to 6), down column A.
	const output: string[] = [];
	for (const mon of team.slice(0, 6)) {
		output.push(mon.nickname === '' ? mon.name : mon.nickname);
		output.push(mon.name);
		output.push(mon.item);
		output.push(mon.ability);
		output.push(mon.tera);
		output.push(mon.moves[0], mon.moves[1], mon.moves[2], mon.moves[3]);
		output.push(mon.evs);
	}
	return output;
}
