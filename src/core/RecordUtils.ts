import mergeWith from 'lodash.mergewith';

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function mergeReplacingArrays(target: UnknownRecord, source: UnknownRecord): UnknownRecord {
  return mergeWith({}, target, source, (_targetValue: unknown, sourceValue: unknown) => {
    if (Array.isArray(sourceValue)) return sourceValue;
    return undefined;
  });
}

export function mergeReplacingArraysAndDeletingUndefined(target: UnknownRecord, source: UnknownRecord): UnknownRecord {
  const output = mergeReplacingArrays(target, source);
  deleteUndefinedValues(output, source);
  return output;
}

function deleteUndefinedValues(target: UnknownRecord, source: UnknownRecord): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      delete target[key];
    } else if (isRecord(value) && isRecord(target[key])) {
      deleteUndefinedValues(target[key], value);
    }
  }
}
