/**
 * Converts a Date, ISO string, or null/undefined to a nullable ISO string.
 * Date objects arrive as plain strings after IPC JSON serialisation,
 * so this handles both forms safely.
 */
export function toISOString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.toISOString();
}
