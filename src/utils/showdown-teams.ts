// Read the user's Showdown teams (from the client's global `Storage`) and turn a
// chosen team into the column the PASRS `Team Info From Paste` sheet expects.
// This runs in the page's main world (same as the showdown hook), where the
// Showdown client globals (`Storage`, `Dex`) live — so we can use structured
// team data directly instead of scraping a pokepaste's HTML.

interface ShowdownSet {
	name?: string;
	species?: string;
	moves?: string[];
	teraType?: string;
	item?: string;
	ability?: string;
	evs?: { hp?: number; atk?: number; def?: number; spa?: number; spd?: number; spe?: number };
}

interface ShowdownStorageLike {
	teams?: Array<{
		name?: string;
		format?: string;
		team?: string | ShowdownSet[];
	}>;
	unpackTeam?: (packed: string) => ShowdownSet[];
}

interface DexLike {
	moves?: { get?: (x: string) => { name?: string } | undefined };
	species?: { get?: (x: string) => { name?: string } | undefined };
	items?: { get?: (x: string) => { name?: string } | undefined };
	abilities?: { get?: (x: string) => { name?: string } | undefined };
}

export interface ShowdownTeam {
	name: string;
	format: string;
	sets: ShowdownSet[];
}

// The list of teams from the Showdown teambuilder, newest first as stored.
export function getShowdownTeams(): ShowdownTeam[] {
	const storage = (window as unknown as { Storage?: ShowdownStorageLike })
		.Storage;
	const teams = storage?.teams;
	if (!Array.isArray(teams)) return [];

	return teams.map((entry, index) => {
		let sets: ShowdownSet[] = [];
		if (Array.isArray(entry.team)) {
			sets = entry.team;
		} else if (typeof entry.team === 'string' && storage?.unpackTeam) {
			try {
				sets = storage.unpackTeam(entry.team);
			} catch {
				sets = [];
			}
		}
		return {
			name: entry.name?.trim() || `Team ${index + 1}`,
			format: entry.format ?? '',
			sets,
		};
	});
}

// PASRS 7 importteam format: per mon [nick/name, name, item, ability, tera,
// move1, move2, move3, move4, evs] — 10 items × up to 6 mons written to col A.
export function buildTeamInfoColumn(
	teamName: string,
	sets: ShowdownSet[],
): string[] {
	const dex = (window as unknown as { Dex?: DexLike }).Dex;
	const moveName = (move: string): string =>
		(move && dex?.moves?.get?.(move)?.name) || move;
	const speciesName = (species: string): string =>
		(species && dex?.species?.get?.(species)?.name) || species;
	const itemName = (item: string): string =>
		(item && dex?.items?.get?.(item)?.name) || item;
	const abilityName = (ability: string): string =>
		(ability && dex?.abilities?.get?.(ability)?.name) || ability;

	const formatEvs = (evs?: ShowdownSet['evs']): string => {
		if (!evs) return '';
		const parts: string[] = [];
		if (evs.hp) parts.push(`${evs.hp} HP`);
		if (evs.atk) parts.push(`${evs.atk} Atk`);
		if (evs.def) parts.push(`${evs.def} Def`);
		if (evs.spa) parts.push(`${evs.spa} SpA`);
		if (evs.spd) parts.push(`${evs.spd} SpD`);
		if (evs.spe) parts.push(`${evs.spe} Spe`);
		return parts.join(' / ');
	};

	const out: string[] = [];
	for (const set of sets) {
		const species = speciesName(set.species || set.name || '');
		const nick = set.name && set.name !== set.species ? set.name : species;
		const moves = set.moves ?? [];
		out.push(nick);
		out.push(species);
		out.push(itemName(set.item ?? ''));
		out.push(abilityName(set.ability ?? ''));
		out.push(set.teraType ?? '');
		out.push(
			moveName(moves[0] ?? ''),
			moveName(moves[1] ?? ''),
			moveName(moves[2] ?? ''),
			moveName(moves[3] ?? ''),
		);
		out.push(formatEvs(set.evs));
	}
	void teamName; // team title not used in PASRS 7 column A
	return out;
}
