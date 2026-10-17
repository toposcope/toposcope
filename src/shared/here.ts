/**
 * This instance's name as rows entering here are stamped with it (`toposcope`, #134). Read from
 * Settings at boot and set again on rename, so ingest never reads the control plane. Empty while
 * the instance has no name: its rows store `toposcope` empty, exactly as before.
 */
let here = "";

export function hereName(): string {
  return here;
}

export function setHereName(name: string | null): void {
  here = name ?? "";
}
