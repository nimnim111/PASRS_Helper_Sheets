import type { SettingsKey } from '../../types/settings';
import styled from 'styled-components';

interface SettingsCheckboxProps {
	settingsKey: SettingsKey;
	label: string;
	checked: boolean;
	onChange: (key: SettingsKey, value: boolean) => void;
	disabled?: boolean;
}

const StyledCheckbox = styled.div`
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 2px 9px;

	span {
		font-size: 0.9em;
	}
`;

export function SettingsCheckbox({
	settingsKey,
	label,
	checked,
	onChange,
	disabled,
}: SettingsCheckboxProps) {
	return (
		<StyledCheckbox>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => {
					onChange(settingsKey, e.target.checked);
				}}
				disabled={disabled}
			/>
			<span>{label}</span>
		</StyledCheckbox>
	);
};
