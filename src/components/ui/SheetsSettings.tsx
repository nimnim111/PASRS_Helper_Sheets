import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import { sheetsRequest } from '../../lib/events';
import type { SettingsKey } from '../../types/settings';
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

interface SheetsSettingsProps {
	logToSheets: boolean;
	spreadsheetId: string;
	sheetName: string;
	onCheckboxChange: (key: SettingsKey, value: boolean) => void;
	onTextChange: (key: SettingsKey, value: string) => void;
}

export function SheetsSettings({
	logToSheets,
	spreadsheetId,
	sheetName,
	onCheckboxChange,
	onTextChange,
}: SheetsSettingsProps) {
	const [signedIn, setSignedIn] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [status, setStatus] = useState('');
	const [sheetUrl, setSheetUrl] = useState('');

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

	const handleTestRow = async (): Promise<void> => {
		setBusy(true);
		setError('');
		setStatus('');
		const res = await sheetsRequest('log', {
			spreadsheetId,
			sheetName,
			payload: {
				format: 'TEST',
				p1: 'You',
				p2: 'Opponent',
				result: 'win',
				url: 'https://replay.pokemonshowdown.com/test',
			},
		});
		setBusy(false);
		if (res.ok) {
			setStatus('Test row added.');
			if (res.spreadsheetUrl) setSheetUrl(res.spreadsheetUrl);
		} else {
			setError(res.error || 'Failed to add test row');
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
				{signedIn && (
					<AuthButton
						type="button"
						onClick={handleTestRow}
						disabled={busy || !logToSheets}
					>
						Send test row
					</AuthButton>
				)}
			</AuthRow>

			<SettingsTextInput
				settingsKey="sheets_spreadsheet_id"
				value={spreadsheetId}
				placeholder="Spreadsheet ID (leave blank to auto-create)"
				onChange={onTextChange}
				disabled={!logToSheets}
			/>
			<SettingsTextInput
				settingsKey="sheets_sheet_name"
				value={sheetName}
				placeholder="Sheet/tab name (e.g. Sheet1)"
				onChange={onTextChange}
				disabled={!logToSheets}
			/>

			<HintText>
				{sheetUrl ? (
					<>
						Logging to{' '}
						<a href={sheetUrl} target="_blank" rel="noopener noreferrer">
							your spreadsheet
						</a>
						.
					</>
				) : (
					'Leave the ID blank and a spreadsheet will be created automatically on your first replay.'
				)}
			</HintText>

			{status && <HintText>{status}</HintText>}
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
