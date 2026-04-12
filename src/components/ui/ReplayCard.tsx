import styled from 'styled-components';
import { ReplayRoomState, type RoomReplay } from '../../types/replay';

interface ReplayCardProps {
	roomReplay: RoomReplay;
	onRemove?: () => void;
}

const ReplayCardContainer = styled.div`
	display: flex;
	align-items: center;
	gap: 16px;
	padding: 8px 16px;
	border-bottom: 1px solid var(--border-color);
	color: #000;
	background-color: rgba(251, 251, 251, 0.35);

	&:nth-child(odd) {
		background-color: rgba(251, 251, 251, 0.35);
	}

	&:nth-child(even) {
		background-color: rgba(228, 228, 228, 0.35);
	}

	html.dark & {
		color: #fff;
	}

	html.dark &:nth-child(odd) {
		background-color: rgba(90, 90, 90, 0.35);
	}

	html.dark &:nth-child(even) {
		background-color: rgba(169, 169, 169, 0.35);
	}
`;

const ReplayInfo = styled.section`
	display: flex;
	flex: 1;
	flex-direction: column;
	align-items: flex-start;
	gap: 4px;
`;

const ReplayFormat = styled.span`
	font-size: 10px;
	opacity: 0.75;
`;

const ReplayPlayers = styled.span`
	font-size: 14px;
	font-weight: 600;
	text-align: left;
`;

const ReplayActions = styled.div`
	display: grid;
	gap: 8px;
	margin-left: auto;
	opacity: 0.75;
`;

const ReplayState = styled.span`
	display: flex;
	grid-column: 1;
	align-items: center;
	font-size: 10px;
	letter-spacing: 1px;
	text-transform: uppercase;
`;

const ReplayButtons = styled.div`
	display: flex;
	grid-column: 2;
	align-items: center;

	&:empty {
		display: none;
	}
`;

const ActionButtonBase = styled.button`
	display: flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	padding: 4px;
	border: 0;
	border-radius: 50%;
	background: transparent;
	color: inherit;
	text-decoration: none;
	cursor: pointer;
	aspect-ratio: 1;
	transition: background-color 200ms ease-in-out;

	&:hover {
		background-color: rgba(196, 196, 196, 0.5);
	}

	html.dark &:hover {
		background-color: rgba(177, 177, 177, 0.5);
	}
`;

const ActionButton = styled(ActionButtonBase).attrs({ type: 'button' })``;

const ActionLink = styled.a`
	display: flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	padding: 4px;
	border-radius: 50%;
	background: transparent;
	color: inherit;
	text-decoration: none;
	cursor: pointer;
	aspect-ratio: 1;
	transition: background-color 200ms ease-in-out;

	&:hover {
		background-color: rgba(196, 196, 196, 0.5);
	}

	html.dark &:hover {
		background-color: rgba(177, 177, 177, 0.5);
	}
`;

export function ReplayCard({
	roomReplay,
	onRemove,
}: ReplayCardProps) {
	const isBattleCompleted = (): boolean => {
		return (
			roomReplay.state === ReplayRoomState.Finished ||
			roomReplay.state === ReplayRoomState.Recorded
		);
	};

	const copyToClipboard = (url: string) => {
		if (!url) return;

		navigator.clipboard.writeText(url).catch((err) => {
			console.error('Failed to copy text to clipboard:', err);
		});
	};

	return (
		<ReplayCardContainer>
			<ReplayInfo>
				<ReplayFormat>{roomReplay?.format}</ReplayFormat>
				<ReplayPlayers>
					{roomReplay.p1} vs {roomReplay.p2}
				</ReplayPlayers>
			</ReplayInfo>

			<ReplayActions>
				<ReplayState>
					{isBattleCompleted() ? roomReplay.result : roomReplay.state}
				</ReplayState>
				<ReplayButtons>
					{onRemove && (
						<ActionButton
							className="fa fa-times"
							onClick={onRemove}
							aria-label="Remove replay"
						/>
					)}
					{roomReplay.url && (
						<>
							<ActionButton
								className="fa fa-clipboard"
								onClick={() => copyToClipboard(roomReplay.url)}
								aria-label="Copy replay URL"
							/>
							<ActionLink
								href={roomReplay.url}
								rel="noopener noreferrer"
								className="fa fa-external-link"
								aria-label="Open replay in new tab"
							>
							</ActionLink>
						</>
					)}
				</ReplayButtons>
			</ReplayActions>
		</ReplayCardContainer>
	);
};