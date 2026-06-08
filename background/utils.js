// Rebase a Manyfold @id onto the user's configured URL.
// The server's JSON-LD @id reflects its internal URL (e.g. localhost:3214),
// which differs from the external URL the user accesses. Strip the origin and
// reattach the user-configured base.
export function manyfoldUrl(id, baseUrl) {
  try {
    return `${baseUrl}${new URL(id).pathname}`;
  } catch {
    return `${baseUrl}${id}`;
  }
}

// Returns true when the upload should use collection mode.
// Centralised here so the branching logic is independently testable.
export function shouldUseCollection(fileCount, settings) {
  if (settings.multiModelMode !== "collection") return false;
  if (fileCount > 1) return true;
  return settings.singleProfileCollection === "collection";
}
