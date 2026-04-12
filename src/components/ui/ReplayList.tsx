import styled from 'styled-components';
import { useReplays } from '../../hooks/useReplays';
import { ReplayRoomState } from '../../types/replay';
import { PanelRoot } from './Panel';
import { ReplayCard } from './ReplayCard';

const ReplayListRoot = styled(PanelRoot)`
	gap: 8px;
`;

const ReplayFrame = styled.section`
	display: flex;
	flex: 1;
	flex-direction: column;
	width: 100%;
	max-width: 550px;
	margin: 0 auto 32px;
	border: 1px solid var(--border-color);
	border-radius: 4px;
	overflow: hidden;
`;

const ReplayItems = styled.section`
	display: flex;
	flex: 1;
	flex-direction: column;
	max-height: 100%;
	overflow-y: auto;
	background-color: rgba(242, 247, 250, 0.7);

	html.dark & {
		background-color: rgba(0, 0, 0, 0.7);
	}
`;

const EmptyState = styled.p`
	margin: 16px 0;
	font-size: 10px;
	text-align: center;
	text-transform: uppercase;
	opacity: 0.75;
`;

const ReplayFooter = styled.footer`
	display: flex;
	justify-content: center;
	width: 100%;
	margin-top: auto;
	border-top: 1px solid var(--border-color);
	background-color: rgba(255, 255, 255, 0.7);
	color: inherit;
	text-align: center;
	text-transform: uppercase;
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 1px;

	html.dark & {
		color: #fff;
		background-color: rgba(90, 90, 90, 0.7);
	}
`;

const ReplayFooterAction = styled.button`
	display: flex;
	flex: 1;
	align-items: center;
	justify-content: center;
	padding: 8px;
	border: 0;
	background: transparent;
	color: inherit;
	text-transform: inherit;
	font: inherit;
	letter-spacing: inherit;
	cursor: pointer;
	transition: background-color 250ms;

	&:hover {
		background-color: rgba(200, 200, 200, 0.7);
	}

	html.dark &:hover {
		background-color: rgba(120, 120, 120, 0.7);
	}
`;

const ReplayFooterDivider = styled.div`
	width: 1px;
	background-color: var(--border-color);
`;

export function ReplayList() {
	const { replays, clearAllReplays, copyAllReplays, removeReplay } =
		useReplays();
	const shownReplays = replays.filter(
		(replay) => replay.state !== ReplayRoomState.Ignored,
	);

	return (
		<ReplayListRoot>
			<ReplayFrame>
				<ReplayItems>
					{shownReplays.length === 0 ? (
						<EmptyState>No replays available</EmptyState>
					) : (
						shownReplays.map((replay) => (
							<ReplayCard
								key={replay.id}
								roomReplay={replay}
								onRemove={() => removeReplay(replay.id)}
							/>
						))
					)}
				</ReplayItems>
				<ReplayFooter>
					<ReplayFooterAction type="button" onClick={clearAllReplays}>
						Clear All Replays
					</ReplayFooterAction>
					<ReplayFooterDivider />
					<ReplayFooterAction type="button" onClick={copyAllReplays}>
						Copy All Replays
					</ReplayFooterAction>
				</ReplayFooter>
			</ReplayFrame>
		</ReplayListRoot>
	);
}