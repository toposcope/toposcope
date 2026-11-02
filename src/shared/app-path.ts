/**
 * The app's own paths: the roots an app is deployed under, which `e1` strips before hashing a
 * frame's file, and which code links (#393) read as the repository's root.
 */
export const appRootPattern = /^(?:\/usr\/src\/app|\/var\/www[^/]*|\/app|\/src|\/home\/[^/]+)(?=\/|$)/i;

/** A file's path with slashes, no scheme, no drive, no line, and no Capistrano-style release dir. */
export function cleanFramePath(file: string): string {
  return file
    .replace(/\\/g, "/")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/^file:\/\//i, "")
    .replace(/^[a-z]:\//i, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/releases\/(?:\d{8,14}|\d{4}-\d{2}-\d{2})(?=\/)/gi, "");
}

/** `/app/src/billing/charge.js` → `src/billing/charge.js`; null when the file is not under an app root. */
export function appRelativePath(file: string): string | null {
  const path = cleanFramePath(file);
  if (!appRootPattern.test(path)) {
    return null;
  }
  const rel = path.replace(appRootPattern, "").replace(/^\//, "");
  return rel.length > 0 ? rel : null;
}
