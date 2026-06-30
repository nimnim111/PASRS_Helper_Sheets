import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import { sheetsRequest } from '../../lib/events';
import type { SettingsKey } from '../../types/settings';
import {
	type ShowdownTeam,
	buildTeamInfoColumn,
	getShowdownTeams,
} from '../../utils/showdown-teams';
import { SettingsCheckbox } from './SettingsCheckBox';
import { SettingsTextInput } from './SettingsTextInput';

const SHEETS_GUIDE_URL =
	'https://github.com/alchemistake/PASRS_helper/blob/main/.github/CONTRIBUTING.md#google-sheets-integration';

const AuthRow = styled.div`
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 13px;
`;

const AuthButton = styled.button`
	padding: 3px 12px;
	border: 1px solid #ccc;
	border-radius: 4px;
	background: transparent;
	color: inherit;
	cursor: pointer;
	font-size: 0.85em;

	&:hover:not(:disabled) {
		border-color: var(--border-color);
	}

	&:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
`;

const StatusText = styled.span<{ $signedIn: boolean }>`
	font-size: 0.8em;
	opacity: 0.85;
	color: ${({ $signedIn }) => ($signedIn ? '#3a9d3a' : 'inherit')};
`;

const ErrorText = styled.span`
	padding: 0 13px;
	font-size: 0.8em;
	color: #c0392b;
`;

const HintText = styled.span`
	padding: 4px 13px 0;
	font-size: 0.8em;
	opacity: 0.85;
`;

const GuideLink = styled.a`
	padding: 4px 13px 0;
	font-size: 0.8em;
	opacity: 0.85;
	text-decoration: underline;
	cursor: pointer;
`;

const TeamSelect = styled.select`
	flex: 1;
	margin: 2px 13px;
	padding: 3px 6px;
	border: 1px solid #ccc;
	border-radius: 4px;
	font-size: 12px;
	background: transparent;
	color: inherit;

	&:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
`;

interface SheetsSettingsProps {
	logToSheets: boolean;
	spreadsheetId: string;
	teamPasteUrl: string;
	onCheckboxChange: (key: SettingsKey, value: boolean) => void;
	onTextChange: (key: SettingsKey, value: string) => void;
}

export function SheetsSettings({
	logToSheets,
	spreadsheetId,
	teamPasteUrl,
	onCheckboxChange,
	onTextChange,
}: SheetsSettingsProps) {
	const [signedIn, setSignedIn] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [sheetUrl, setSheetUrl] = useState('');
	const [teamBusy, setTeamBusy] = useState(false);
	const [teamStatus, setTeamStatus] = useState('');
	const [creating, setCreating] = useState(false);
	const [teams, setTeams] = useState<ShowdownTeam[]>([]);
	const [selectedTeam, setSelectedTeam] = useState(0);

	useEffect(() => {
		setTeams(getShowdownTeams());
	}, []);

	const refreshSheet = useCallback(() => {
		sheetsRequest('spreadsheet', { spreadsheetId }).then((res) => {
			if (res.ok) setSheetUrl(res.spreadsheetUrl ?? '');
		});
	}, [spreadsheetId]);

	useEffect(() => {
		sheetsRequest('status').then((res) => {
			if (res.ok) setSignedIn(!!res.signedIn);
		});
	}, []);

	useEffect(() => {
		refreshSheet();
	}, [refreshSheet]);

	const handleSignIn = async (): Promise<void> => {
		setBusy(true);
		setError('');
		const res = await sheetsRequest('auth');
		setBusy(false);
		if (res.ok) {
			setSignedIn(true);
			refreshSheet();
		} else {
			setError(res.error || 'Sign-in failed');
		}
	};

	const handleSignOut = async (): Promise<void> => {
		setBusy(true);
		setError('');
		await sheetsRequest('signout');
		setBusy(false);
		setSignedIn(false);
	};

	const handleCreate = async (): Promise<void> => {
		setCreating(true);
		setError('');
		const res = await sheetsRequest('create', undefined, 120000);
		setCreating(false);
		if (res.ok && res.spreadsheetId) {
			onTextChange('sheets_spreadsheet_id', res.spreadsheetId);
			setSheetUrl(res.spreadsheetUrl ?? '');
		} else {
			setError(res.error || 'Could not create tracker');
		}
	};

	const handleUseTeam = async (): Promise<void> => {
		const team = teams[selectedTeam];
		if (!team) return;
		setTeamBusy(true);
		setTeamStatus('');
		setError('');
		const teamData = buildTeamInfoColumn(team.name, team.sets);
		const res = await sheetsRequest('team', { spreadsheetId, teamData });
		setTeamBusy(false);
		if (res.ok) {
			setTeamStatus('Team updated');
		} else {
			setError(res.error || 'Could not update team');
		}
	};

	const handleSyncTeam = async (): Promise<void> => {
		setTeamBusy(true);
		setTeamStatus('');
		setError('');
		const res = await sheetsRequest('team', { spreadsheetId, teamPasteUrl });
		setTeamBusy(false);
		if (res.ok) {
			setTeamStatus('Team updated');
		} else {
			setError(res.error || 'Could not update team');
		}
	};

	return (
		<>
			<SettingsCheckbox
				settingsKey="log_to_sheets"
				label="Log recorded replays to Google Sheets"
				checked={logToSheets}
				onChange={onCheckboxChange}
			/>

			<AuthRow>
				{signedIn ? (
					<AuthButton type="button" onClick={handleSignOut} disabled={busy}>
						Sign out
					</AuthButton>
				) : (
					<AuthButton
						type="button"
						onClick={handleSignIn}
						disabled={busy || !logToSheets}
					>
						Sign in with Google
					</AuthButton>
				)}
				<StatusText $signedIn={signedIn}>
					{signedIn ? 'Signed in' : 'Not signed in'}
				</StatusText>
			</AuthRow>

			<SettingsTextInput
				settingsKey="sheets_spreadsheet_id"
				value={spreadsheetId}
				placeholder="PASRS spreadsheet ID (or create one →)"
				onChange={onTextChange}
				disabled={!logToSheets}
			/>

			<AuthRow>
				<AuthButton
					type="button"
					onClick={handleCreate}
					disabled={creating || !logToSheets || !signedIn}
				>
					{creating ? 'Creating…' : 'Create tracker'}
				</AuthButton>
				<StatusText $signedIn={false}>
					Makes a new PASRS sheet in your Drive
				</StatusText>
			</AuthRow>

			<HintText>
				{sheetUrl ? (
					<>
						Filling in your{' '}
						<a href={sheetUrl} target="_blank" rel="noopener noreferrer">
							PASRS tracker
						</a>{' '}
						from each recorded replay.
					</>
				) : (
					'Click "Create tracker" to make a PASRS sheet automatically, or paste an existing spreadsheet ID.'
				)}
			</HintText>

			<HintText>Set your team (fills the Usage Stats page):</HintText>

			{teams.length > 0 ? (
				<>
					<TeamSelect
						value={selectedTeam}
						disabled={!logToSheets || teamBusy}
						onChange={(e) => setSelectedTeam(Number(e.target.value))}
					>
						{teams.map((team, index) => (
							<option key={`${team.name}-${index}`} value={index}>
								{team.name}
								{team.format ? ` (${team.format})` : ''}
							</option>
						))}
					</TeamSelect>

					<AuthRow>
						<AuthButton
							type="button"
							onClick={handleUseTeam}
							disabled={teamBusy || !logToSheets || !signedIn}
						>
							Use selected team
						</AuthButton>
						{teamStatus && (
							<StatusText $signedIn={true}>{teamStatus}</StatusText>
						)}
					</AuthRow>
				</>
			) : (
				<>
					<SettingsTextInput
						settingsKey="sheets_team_paste_url"
						value={teamPasteUrl}
						placeholder="Your team pokepaste URL (pokepast.es/…)"
						onChange={onTextChange}
						disabled={!logToSheets}
					/>
					<AuthRow>
						<AuthButton
							type="button"
							onClick={handleSyncTeam}
							disabled={teamBusy || !logToSheets || !signedIn || !teamPasteUrl}
						>
							Update team in sheet
						</AuthButton>
						{teamStatus && (
							<StatusText $signedIn={true}>{teamStatus}</StatusText>
						)}
					</AuthRow>
				</>
			)}

			{error && <ErrorText>{error}</ErrorText>}

			<GuideLink
				href={SHEETS_GUIDE_URL}
				target="_blank"
				rel="noopener noreferrer"
			>
				How to set this up
			</GuideLink>
		</>
	);
}
