export interface TeamMon {
	species: string;
	item: string;
	moves: string;
	sprite: string; // sprite image URL (empty if unknown)
}

export interface RoomReplay {
	id: string;
	state: ReplayRoomState;
	url: string;
	format?: string;
	p1: string;
	p2: string;
	result: ReplayRoomResult;
	// Battle details collected from the protocol stream, used for Sheets logging.
	mySide?: 'p1' | 'p2';
	myTeam?: TeamMon[];
	myTeamSpecies?: string[];
	oppTeamSpecies?: string[];
	p1Elo?: string;
	p2Elo?: string;
	myEloBefore?: string;
	myEloAfter?: string;
	myEloDelta?: string;
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
