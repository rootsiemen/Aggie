/**
 * Single helper for building incident comment attachment URLs. Attachment `path`s are
 * `/incidents/uploads/<filename>` (served by the authenticated
 * `GET /incidents/uploads/:filename` route); they need the CRA `PUBLIC_URL` base prefix so
 * deployments served under a subpath resolve correctly. Anything else (e.g. not-yet-uploaded
 * `File` entries' relative paths) passes through unchanged.
 *
 * Replaces the two ad-hoc prefix implementations that used to live in `Comment.tsx`
 * (which also read `process.env.UPLOAD_DIR` — always `undefined` in the browser) and
 * `FileChip.tsx` (which fell back to a hardcoded `http://localhost:3000`).
 */
export function buildMediaUrl(path: string): string {
  if (!path || !path.startsWith("/incidents/uploads/")) return path;
  const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  return `${base}${path}`;
}
