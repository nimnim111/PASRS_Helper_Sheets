import type { TeamMon } from '../types/replay';

// The Showdown client exposes a global `Dex` we can use to turn internal ids
// (e.g. "focussash") into display names (e.g. "Focus Sash"). It isn't typed, and
// may not always be present, so everything here is defensive.
declare const Dex:
	| {
			items?: { get?: (id: string) => { name?: string } };
			moves?: { get?: (id: string) => { name?: string } };
			species?: { get?: (id: string) => { spriteid?: string } };
	  }
	| undefined;

// Pokémon HOME official artwork; covers modern (gen 8/9) species as static PNGs.
const SPRITE_BASE = 'https://play.pokemonshowdown.com/sprites/home';

function spriteUrl(species: string): string {
	if (!species) return '';
	let id = '';
	try {
		id = Dex?.species?.get?.(species)?.spriteid ?? '';
	} catch {
		id = '';
	}
	// Fallback id: lowercase, drop spaces/apostrophes/periods, keep forme hyphens.
	if (!id) id = species.toLowerCase().replace(/[^a-z0-9-]/g, '');
	return id ? `${SPRITE_BASE}/${id}.png` : '';
}

function prettyItem(id: string): string {
	if (!id) return '';
	try {
		return Dex?.items?.get?.(id)?.name || id;
	} catch {
		return id;
	}
}

function prettyMove(id: string): string {
	if (!id) return '';
	try {
		return Dex?.moves?.get?.(id)?.name || id;
	} catch {
		return id;
	}
}

export function isRequestMessage(data: string): boolean {
	return data.includes('|request|');
}

export function isPlayerMessage(data: string): boolean {
	return data.includes('|player|');
}

export function isTeamPreviewMessage(data: string): boolean {
	return data.includes('|poke|');
}

export function isRatingMessage(data: string): boolean {
	return data.includes('|raw|') && data.includes('rating:');
}

interface ParsedRequest {
	side: 'p1' | 'p2';
	team: TeamMon[];
	species: string[];
}

/**
 * Parse the player's own team (species, item, moves) from a `|request|` message.
 * The request payload is private to the player and is the only place that
 * carries the full team including items and moves.
 */
export function parseRequestTeam(data: string): ParsedRequest | null {
	const line = data.split('\n').find((l) => l.startsWith('|request|'));
	if (!line) return null;

	const json = line.slice('|request|'.length).trim();
	if (!json) return null;

	let parsed: {
		side?: {
			id?: string;
			pokemon?: Array<{ details?: string; item?: string; moves?: string[] }>;
		};
	};
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}

	const sideId = parsed.side?.id;
	const pokemon = parsed.side?.pokemon;
	if ((sideId !== 'p1' && sideId !== 'p2') || !Array.isArray(pokemon)) {
		return null;
	}

	const team: TeamMon[] = pokemon.map((mon) => {
		const species = (mon.details ?? '').split(',')[0].trim();
		const moves = Array.isArray(mon.moves)
			? mon.moves.map(prettyMove).join(' / ')
			: '';
		return {
			species,
			item: prettyItem(mon.item ?? ''),
			moves,
			sprite: spriteUrl(species),
		};
	});

	return {
		side: sideId,
		team,
		species: team.map((mon) => mon.species).filter(Boolean),
	};
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
