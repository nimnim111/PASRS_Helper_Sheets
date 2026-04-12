import styled from 'styled-components';

export const PanelRoot = styled.section`
	display: flex;
	flex: 1;
	flex-direction: column;
	padding: 1em 1em 0;
`;

export const PanelTitle = styled.h3`
	margin: 0 0 6px;
	font-size: 1em;
	font-weight: 400;
	letter-spacing: 1px;
`;

export const PanelDivider = styled.hr`
	width: 100%;
	height: 1px;
	border: none;
	background-color: var(--border-color);
	opacity: 0.35;
`;