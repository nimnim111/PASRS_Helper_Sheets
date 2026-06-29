import styled from 'styled-components';
import { useSettings } from '../../hooks/useSettings';
import type { SettingsKey } from '../../types/settings';
import { PanelDivider, PanelRoot, PanelTitle } from './Panel';
import { SettingsCheckbox } from './SettingsCheckBox';
import { SettingsFormatSelect } from './SettingsFormatSelect';
import { SheetsSettings } from './SheetsSettings';

// @ts-ignore : VERSION is injected by the bundler
const VERSION_TEXT = VERSION;

const SettingsRoot = styled(PanelRoot)``;

const SettingsGroup = styled.section`
	display: flex;
	flex-direction: column;
	align-items: flex-start;
`;

const GroupLabel = styled.span`
	padding: 0 12px 6px;
	font-size: 0.9em;
`;

const BottomDivider = styled(PanelDivider)`
	margin: auto 0 16px;
`;

const InfoSection = styled.section`
	display: flex;
	align-items: flex-end;
	justify-content: center;
	gap: 32px;
	padding: 8px 0;
	font-size: 0.9em;
	opacity: 0.85;
`;

const InfoButton = styled.button`
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 4px;
	padding: 6px;
	border: none;
	border-radius: 4px;
	background-color: transparent;
	cursor: pointer;

	&:hover {
		background-color: #ababab69;
	}

	i {
		font-size: 1.5em;
	}
`;

const VersionLabel = styled.span`
	padding: 6px;
`;

const generalSettings: Array<{ key: SettingsKey; label: string }> = [
	{ key: 'active', label: 'Enable Automatic Replay Upload' },
	{ key: 'use_clipboard', label: 'Put new replays in clipboard' },
	{ key: 'notifications', label: 'Enable Upload Done Notifications' },
	{ key: 'clear_on_copy', label: 'Clear all replays after copy all' },
];

const filterSettings: Array<{ key: SettingsKey; label: string }> = [
	{ key: 'vgc_only', label: 'VGC Mode (Only save VGC replays)' },
	{ key: 'use_custom_replay_filter', label: 'Use Custom Replay Filter' },
];

export function Settings() {
	const { settings, updateSetting, customFormats } = useSettings();

	const handleCheckboxChange = (key: SettingsKey, value: boolean): void => {
		updateSetting(key, value);
	};

	const handleFormatSelectChange = (
		key: SettingsKey,
		value: string[],
	): void => {
		updateSetting(key, value);
	};

	const handleTextChange = (key: SettingsKey, value: string): void => {
		updateSetting(key, value);
	};

	return (
		<SettingsRoot>
			<PanelTitle>Settings</PanelTitle>
			<SettingsGroup>
				{generalSettings.map(({ key, label }) => (
					<SettingsCheckbox
						key={key}
						settingsKey={key}
						label={label}
						checked={settings[key] as boolean}
						onChange={handleCheckboxChange}
					/>
				))}
			</SettingsGroup>

			<PanelDivider />

			<SettingsGroup>
				<GroupLabel>Replay Filtering</GroupLabel>
				{filterSettings.map(({ key, label }) => (
					<SettingsCheckbox
						key={key}
						settingsKey={key}
						label={label}
						checked={settings[key] as boolean}
						onChange={handleCheckboxChange}
						disabled={
							key === 'vgc_only'
								? settings.use_custom_replay_filter
								: settings.vgc_only
						}
					/>
				))}

				<SettingsFormatSelect
					settingsKey="custom_replay_filter"
					value={settings.custom_replay_filter}
					customFormats={customFormats}
					onChange={handleFormatSelectChange}
					disabled={!settings.use_custom_replay_filter}
				/>
			</SettingsGroup>

			<PanelDivider />

			<SettingsGroup>
				<GroupLabel>Google Sheets</GroupLabel>
				<SheetsSettings
					logToSheets={settings.log_to_sheets}
					spreadsheetId={settings.sheets_spreadsheet_id}
					sheetName={settings.sheets_sheet_name}
					onCheckboxChange={handleCheckboxChange}
					onTextChange={handleTextChange}
				/>
			</SettingsGroup>

			<BottomDivider />

			<InfoSection>
				<InfoButton type="button" onClick={openCreditsPage}>
					<i className="fa fa-heart" aria-hidden="true"></i>
					Credits
				</InfoButton>
				<InfoButton type="button" onClick={openIssuesPage}>
					<i className="fa fa-bug" aria-hidden="true"></i>
					Report Bug
				</InfoButton>
				<VersionLabel>version {VERSION_TEXT}</VersionLabel>
			</InfoSection>
		</SettingsRoot>
	);
}

const openIssuesPage = (): void => {
	window.open('https://github.com/alchemistake/PASRS_helper/issues', '_blank');
};

const openCreditsPage = (): void => {
	window.open(
		'https://github.com/alchemistake/PASRS_helper/tree/main?tab=contributing-ov-file#maintainers--credits',
		'_blank',
	);
};
