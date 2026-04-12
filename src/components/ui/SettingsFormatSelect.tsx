import React from 'react';
import styled from 'styled-components';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsKey } from '../../types/settings';

interface SettingsFormatSelectProps {
	settingsKey: SettingsKey;
	value: string[];
	customFormats: string[];
	onChange: (key: SettingsKey, value: string[]) => void;
	disabled?: boolean;
}

const Container = styled.div`
	position: relative;
	display: flex;
	flex: 1;
	width: 90%;
	padding: 0 13px;
`;

const Trigger = styled.button<{ $isOpen: boolean }>`
	display: flex;
	flex: 1;
	align-items: center;
	justify-content: space-between;
	padding: 2px 12px;
	border: 1px solid #ccc;
	border-radius: ${({ $isOpen }) => ($isOpen ? '4px 4px 0 0' : '4px')};
	border-bottom: ${({ $isOpen }) => ($isOpen ? 'none' : '1px solid #ccc')};
	background: transparent;
	cursor: pointer;

	&:hover:not(:disabled) {
		border-color: var(--border-color);
	}

	&:disabled {
		background: #f5f5f53a;
		cursor: not-allowed;
		color: #999;
	}
`;

const TriggerValue = styled.span`
	flex: 1;
	overflow: hidden;
	text-align: left;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 12px;
`;

const TriggerArrow = styled.span<{ $isOpen: boolean }>`
	margin-left: 8px;
	font-size: 10px;
	opacity: 0.7;
	transform: ${({ $isOpen }) => ($isOpen ? 'rotate(180deg)' : 'rotate(0deg)')};
`;

const Dropdown = styled.div`
	position: absolute;
	top: 100%;
	left: 0;
	right: 0;
	max-height: 300px;
	overflow: hidden;
	border: 1px solid var(--border-color);
	border-radius: 4px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	background: var(--showdown-background-light);
	z-index: 1000;

	html.dark & {
		background: var(--showdown-background-dark);
	}
`;

const SearchContainer = styled.div`
	padding: 8px;
	border-bottom: 1px solid #eee;
`;

const SearchInput = styled.input`
	width: 90%;
	padding: 2px 8px;
	border: 1px solid #ccc;
	border-radius: 4px;
	font-size: 14px;
	outline: none;
	background: transparent;
	color: inherit;
`;

const OptionsContainer = styled.div`
	max-height: 200px;
	overflow-y: auto;
`;

const OptionItem = styled.button`
	display: flex;
	align-items: center;
	width: 100%;
	padding: 6px 12px;
	border: 0;
	background: transparent;
	cursor: pointer;
	transition: background-color 0.1s ease;

	&:hover {
		background-color: #a3a3a3;
	}
`;

const OptionCheckbox = styled.input`
	margin-right: 8px;
	cursor: pointer;
`;

const OptionLabel = styled.span`
	flex: 1;
	overflow: hidden;
	text-align: left;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 12px;
	user-select: none;
`;

const NoOptions = styled.div`
	padding: 12px;
	text-align: center;
	color: #666;
	font-style: italic;
`;

export function SettingsFormatSelect({
	settingsKey,
	value,
	customFormats,
	onChange,
	disabled,
}: SettingsFormatSelectProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [searchTerm, setSearchTerm] = useState('');
	const dropdownRef = useRef<HTMLDivElement>(null);

	const filteredFormats = customFormats.filter((format) =>
		format.toLowerCase().includes(searchTerm.toLowerCase()),
	);

	const handleToggleOption = (format: string): void => {
		const newValue = value.includes(format)
			? value.filter((v) => v !== format)
			: [...value, format];
		onChange(settingsKey, newValue);
	};

	const handleClickOutside = useCallback((event: MouseEvent) => {
		if (
			dropdownRef.current &&
			!dropdownRef.current.contains(event.target as Node)
		) {
			setIsOpen(false);
			setSearchTerm('');
		}
	}, []);

	useEffect(() => {
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [handleClickOutside]);

	const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
		if (disabled) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			setIsOpen(!isOpen);
		}
	};

	const handleOptionKeyDown = (e: React.KeyboardEvent, format: string) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleToggleOption(format);
		}
	};

	const displayText =
		value.length === 0
			? 'Select formats...'
			: value.length === 1
				? value[0]
				: `${value.length} formats selected`;

	return (
		<Container ref={dropdownRef}>
			<Trigger
				type="button"
				$isOpen={isOpen}
				onClick={() => !disabled && setIsOpen(!isOpen)}
				onKeyDown={handleTriggerKeyDown}
				disabled={disabled}
				aria-expanded={isOpen}
			>
				<TriggerValue>{displayText}</TriggerValue>
				<TriggerArrow $isOpen={isOpen}>▼</TriggerArrow>
			</Trigger>

			{isOpen && !disabled && (
				<Dropdown>
					<SearchContainer>
						<SearchInput
							type="text"
							placeholder="Search formats..."
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
							onClick={(e) => e.stopPropagation()}
						/>
					</SearchContainer>

					<OptionsContainer>
						{filteredFormats.length === 0 ? (
							<NoOptions>No formats found</NoOptions>
						) : (
							filteredFormats.map((format) => (
								<OptionItem
									type="button"
									key={format}
									onClick={() => handleToggleOption(format)}
									onKeyDown={(e) => handleOptionKeyDown(e, format)}
								>
									<OptionCheckbox
										type="checkbox"
										checked={value.includes(format)}
										onChange={() => {}}
										tabIndex={-1}
									/>
									<OptionLabel>{format}</OptionLabel>
								</OptionItem>
							))
						)}
					</OptionsContainer>
				</Dropdown>
			)}
		</Container>
	);
};