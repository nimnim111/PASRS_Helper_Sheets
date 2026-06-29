export function isPlayerMessage(data: string): boolean {
	return data.includes('|player|');
}

export function isTeamPreviewMessage(data: string): boolean {
	return data.includes('|poke|');
}

export function isRatingMessage(data: string): boolean {
	return data.includes('|raw|') && data.includes('rating:');
}

export function isBattleEventMessage(data: string): boolean {
	return (
		data.includes('|switch|') ||
		data.includes('|drag|') ||
		data.includes('|-terastallize|') ||
		data.includes('|rule|')
	);
}

export interface BattleEvents {
	switches: Array<{ side: 'p1' | 'p2'; position: string; species: string }>;
	teras: Array<{ side: 'p1' | 'p2'; position: string; type: string }>;
	ots: boolean;
}

/**
 * Parse switch-ins (which Pokémon were brought, in order), Terastallizations
 * (position + type), and whether the format is Open Team Sheet.
 */
export function parseBattleEvents(data: string): BattleEvents {
	const switches: BattleEvents['switches'] = [];
	const teras: BattleEvents['teras'] = [];
	let ots = false;

	for (const line of data.split('\n')) {
		if (line.startsWith('|switch|') || line.startsWith('|drag|')) {
			const parts = line.split('|'); // ['', 'switch', 'p1a: Nick', 'Species, L50, M', hp]
			const position = (parts[2] ?? '').split(':')[0].trim(); // p1a
			const species = (parts[3] ?? '').split(',')[0].trim();
			const side = position.slice(0, 2);
			if ((side === 'p1' || side === 'p2') && species) {
				switches.push({ side, position, species });
			}
		} else if (line.startsWith('|-terastallize|')) {
			const parts = line.split('|'); // ['', '-terastallize', 'p1a: Nick', 'Fairy']
			const position = (parts[2] ?? '').split(':')[0].trim();
			const type = (parts[3] ?? '').trim();
			const side = position.slice(0, 2);
			if ((side === 'p1' || side === 'p2') && type) {
				teras.push({ side, position, type });
			}
		} else if (line.startsWith('|rule|')) {
			if (line.toLowerCase().includes('open team sheet')) ots = true;
		}
	}

	return { switches, teras, ots };
}

/**
 * Parse the opponent's revealed species from team-preview `|poke|` lines for the
 * given opponent side. In VGC all six species are shown at team preview.
 */
export function parseOpponentSpecies(
	data: string,
	oppSide: 'p1' | 'p2',
): string[] {
	const species: string[] = [];
	for (const line of data.split('\n')) {
		if (!line.startsWith('|poke|')) continue;
		const parts = line.split('|'); // ['', 'poke', 'p2', 'Species, L50', 'item']
		if (parts[2] !== oppSide) continue;
		const name = (parts[3] ?? '').split(',')[0].trim();
		if (name) species.push(name);
	}
	return species;
}

interface PlayerInfo {
	name?: string;
	rating?: string;
}

/**
 * Parse names and current ratings from `|player|` lines, per side.
 * Format: |player|p1|Username|avatar|rating  (rating is empty when unrated).
 */
export function parsePlayers(data: string): {
	p1: PlayerInfo;
	p2: PlayerInfo;
} {
	const players: { p1: PlayerInfo; p2: PlayerInfo } = { p1: {}, p2: {} };
	for (const line of data.split('\n')) {
		if (!line.startsWith('|player|')) continue;
		const parts = line.split('|'); // ['', 'player', 'p1', name, avatar, rating]
		const side = parts[2];
		if (side !== 'p1' && side !== 'p2') continue;
		const name = (parts[3] ?? '').trim();
		const rating = (parts[5] ?? '').trim();
		if (name) players[side].name = name;
		if (rating) players[side].rating = rating;
	}
	return players;
}

/**
 * Parse the post-game rating change for a given user from a `|raw|` message,
 * e.g. "...Username's rating: 1520 &rarr; 1536<br />(+16 for winning)".
 */
export function parseRatingChange(
	data: string,
	username: string,
): { before: string; after: string; delta: string } | null {
	const lower = username.toLowerCase();
	for (const line of data.split('\n')) {
		if (!line.startsWith('|raw|') || !line.includes('rating:')) continue;
		if (!line.toLowerCase().includes(lower)) continue;

		const range = line.match(
			/rating:\s*(\d+)\s*(?:&rarr;|→|-&gt;|->)\s*(?:<strong>)?(\d+)/i,
		);
		if (!range) continue;
		const deltaMatch = line.match(/\(([+\-]\d+)/);
		return {
			before: range[1],
			after: range[2],
			delta: deltaMatch ? deltaMatch[1] : '',
		};
	}
	return null;
}
