/** US phone formatting helpers — (480) 246-7200 */

/** Digits only, max 10 (US local) or 11 if leading 1. */
export function digitsOnlyPhone(input: string): string {
  const d = input.replace(/\D/g, '');
  if (d.length > 11) return d.slice(0, 11);
  // Strip leading country code 1 when we already have 11 digits
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  if (d.length > 10) return d.slice(0, 10);
  return d;
}

/**
 * Format as user types:
 * 4 → (4
 * 480 → (480
 * 4802 → (480) 2
 * 4802467200 → (480) 246-7200
 */
export function formatPhoneUS(input: string): string {
  const d = digitsOnlyPhone(input);
  if (!d) return '';
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
}

/** Normalize stored values for display (handles raw digits or partial). */
export function displayPhoneUS(input: string | undefined | null): string {
  if (!input) return '';
  return formatPhoneUS(input);
}
