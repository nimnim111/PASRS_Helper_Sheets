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

// Build the `Team Info From Paste` column (written down column A), matching the
// order TEAMDATAFROMPASTE produced: per mon [species, m1, m2, m3, m4], then all
// tera types, then all nicknames, then the team title.
export function buildTeamInfoColumn(
	teamName: string,
	sets: ShowdownSet[],
): string[] {
	const dex = (window as unknown as { Dex?: DexLike }).Dex;
	const moveName = (move: string): string =>
		(move && dex?.moves?.get?.(move)?.name) || move;
	const speciesName = (species: string): string =>
		(species && dex?.species?.get?.(species)?.name) || species;

	const out: string[] = [];
	const teras: string[] = [];
	const nicks: string[] = [];

	for (const set of sets) {
		const species = speciesName(set.species || set.name || '');
		out.push(species);
		const moves = set.moves ?? [];
		out.push(
			moveName(moves[0] ?? ''),
			moveName(moves[1] ?? ''),
			moveName(moves[2] ?? ''),
			moveName(moves[3] ?? ''),
		);
		teras.push(set.teraType ?? '');
		// In-battle nickname (what appears in replays); falls back to species.
		const nick = set.name && set.name !== set.species ? set.name : species;
		nicks.push(nick);
	}

	for (const tera of teras) out.push(tera);
	for (const nick of nicks) out.push(nick);
	out.push(teamName);
	return out;
}
