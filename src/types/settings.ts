export interface Settings {
	active: boolean;
	notifications: boolean;
	vgc_only: boolean;
	use_clipboard: boolean;
	use_custom_replay_filter: boolean;
	custom_replay_filter: string[];
	clear_on_copy: boolean;
	log_to_sheets: boolean;
	sheets_spreadsheet_id: string;
	sheets_sheet_name: string;
	sheets_team_paste_url: string;
}

export type SettingsKey = keyof Settings;
