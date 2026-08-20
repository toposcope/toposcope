/** Lookup/ignore keys copied from SQLite into ClickHouse `field_role_skip`. */
let skipKeys: readonly string[] = [];

export function getFieldSkipKeys(): readonly string[] {
  return skipKeys;
}

export function setFieldSkipKeys(keys: readonly string[]): void {
  skipKeys = keys;
}
