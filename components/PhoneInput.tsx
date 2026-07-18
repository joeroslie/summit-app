'use client';

import { formatPhoneUS } from '@/lib/phone';

type PhoneInputProps = {
  value: string;
  onChange: (formatted: string) => void;
  className?: string;
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  autoComplete?: string;
};

/** Controlled phone input with live US mask: (480) 246-7200 */
export default function PhoneInput({
  value,
  onChange,
  className = '',
  placeholder = '(480) 555-0100',
  id,
  name,
  disabled,
  autoComplete = 'tel-national',
}: PhoneInputProps) {
  return (
    <input
      id={id}
      name={name}
      type="tel"
      inputMode="numeric"
      autoComplete={autoComplete}
      disabled={disabled}
      value={value}
      placeholder={placeholder}
      className={className}
      onChange={(e) => onChange(formatPhoneUS(e.target.value))}
      onBlur={(e) => {
        // Normalize partial paste on blur
        const next = formatPhoneUS(e.target.value);
        if (next !== e.target.value) onChange(next);
      }}
      maxLength={14}
    />
  );
}
