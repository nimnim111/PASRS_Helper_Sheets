export interface RoomReplay {
	id: string;
	state: ReplayRoomState;
	url: string;
	format?: string;
	p1: string;
	p2: string;
	result: ReplayRoomResult;
	// Battle details collected from the protocol stream for PASRS GBG logging.
	mySide?: 'p1' | 'p2';
	oppTeamSpecies?: string[]; // opponent's revealed 6 (team preview)
	// Picks (species brought, in switch-in order) per side; first 2 are leads.
	p1Picks?: string[];
	p2Picks?: string[];
	positions?: Record<string, string>; // battle position (e.g. p1a) -> species
	p1TeraMon?: string;
	p1TeraType?: string;
	p2TeraMon?: string;
	p2TeraType?: string;
	ots?: boolean; // Open Team Sheet format
	p1Elo?: string; // current rating from |player| (battle start)
	p2Elo?: string;
	myEloBefore?: string; // from post-game rating change
	myEloAfter?: string;
}

export enum ReplayRoomState {
	Initialized = 'initialized',
	Ignored = 'ignored',
	OnGoing = 'ongoing',
	Finished = 'finished',
	Forfeited = 'forfeited',
	Recorded = 'recorded',
}

export enum ReplayRoomResult {
	Unknown = 'unknown',
	Win = 'win',
	Loss = 'loss',
	Draw = 'draw',
}
