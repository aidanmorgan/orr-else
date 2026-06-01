/**
 * Pure utility functions shared across projectTools modules.
 * Package-internal — do not import from outside src/plugins/.
 */

export function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function resultRecord(result: unknown): Record<string, unknown> {
  return isJsonRecord(result) ? result : { result };
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function serializeProjectToolResult(result: unknown): string {
  return JSON.stringify(result, null, 2) ?? String(result);
}

export function searchableFailureText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) || String(value);
  } catch {
    return String(value);
  }
}

export function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter(line => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

export function stringField(value: unknown, key: string): string | undefined {
  return isJsonRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

export function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

export function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isJsonRecord(value)) return undefined;
  return isJsonRecord(value[key]) ? value[key] as Record<string, unknown> : undefined;
}
