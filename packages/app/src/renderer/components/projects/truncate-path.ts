// Keeps the start and end of a long path visible (where the meaningful project folder
// name usually lives) instead of a plain end-ellipsis, e.g. "/Users/.../Develop/acme".
export function truncateMiddle(path: string, max = 42): string {
  if (path.length <= max) return path;
  const keep = Math.floor((max - 3) / 2);
  return `${path.slice(0, keep)}...${path.slice(-keep)}`;
}
