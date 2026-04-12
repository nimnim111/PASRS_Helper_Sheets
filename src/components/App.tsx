import '../styles/_variables.css';
import styled, { createGlobalStyle } from 'styled-components';
import { ReplayList } from './ui/ReplayList';
import { Settings } from './ui/Settings';

const GlobalStyle = createGlobalStyle`
	#react-root {
		height: 100%;
		overflow: hidden;
	}
`;

const AppShell = styled.div`
	display: flex;
	height: 100%;
	flex-direction: column;
	text-align: center;
	container-type: inline-size;
	container-name: pasrs-app;
`;

const AppHeader = styled.header`
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 4px;
	padding: 1em;
	border-bottom: 1px solid var(--border-color);
`;

const Title = styled.h1`
	margin: 0;
	font-size: 2.5em;
	font-weight: 700;
	letter-spacing: 1.5px;
`;

const Subtitle = styled.h2`
	margin: 0;
	font-size: 1.1em;
	font-weight: 400;
	opacity: 0.85;
`;

const Content = styled.section`
	display: flex;
	flex: 1;
	height: 0;

	@container pasrs-app (max-width: 654px) {
		.settings-section {
			display: none;
		}
	}
`;

const ReplaySection = styled.section`
	display: flex;
	flex: 1;
	border-right: 1px solid var(--border-color);
`;

const SettingsSection = styled.section`
	display: flex;
	flex: 0 0 360px;
	background-color: var(--showdown-background-light);

	html.dark & {
		background-color: var(--showdown-background-dark);
	}
`;

const App = () => {
	return (
		<>
			<GlobalStyle />
			<AppShell>
				<AppHeader>
					<Title>PASRS Helper</Title>
					<Subtitle>
						A tool to help record your replays for faster processing of PASRS
					</Subtitle>
				</AppHeader>
				<Content>
					<ReplaySection>
						<ReplayList />
					</ReplaySection>
					<SettingsSection className="settings-section">
						<Settings />
					</SettingsSection>
				</Content>
			</AppShell>
		</>
	);
};

export default App;
