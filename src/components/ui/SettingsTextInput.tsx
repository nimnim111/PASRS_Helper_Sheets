import styled from 'styled-components';
import type { SettingsKey } from '../../types/settings';

interface SettingsTextInputProps {
	settingsKey: SettingsKey;
	value: string;
	placeholder?: string;
	onChange: (key: SettingsKey, value: string) => void;
	disabled?: boolean;
}

const Container = styled.div`
	display: flex;
	flex: 1;
	width: 90%;
	padding: 2px 13px;
`;

const Input = styled.input`
	flex: 1;
	padding: 2px 8px;
	border: 1px solid #ccc;
	border-radius: 4px;
	font-size: 12px;
	outline: none;
	background: transparent;
	color: inherit;

	&:disabled {
		background: #f5f5f53a;
		cursor: not-allowed;
		color: #999;
	}
`;

export function SettingsTextInput({
	settingsKey,
	value,
	placeholder,
	onChange,
	disabled,
}: SettingsTextInputProps) {
	return (
		<Container>
			<Input
				type="text"
				value={value}
				placeholder={placeholder}
				disabled={disabled}
				onChange={(e) => onChange(settingsKey, e.target.value)}
			/>
		</Container>
	);
}
