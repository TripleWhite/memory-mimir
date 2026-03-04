/**
 * Shared helpers for migration module — extracted for testability.
 */

import { basename, extname } from "node:path";

/** Extract a timestamp hint from a memory filename, if any. */
export function extractDateFromFilename(filename: string): string | undefined {
  const name = basename(filename, extname(filename));

  // Match patterns like "2025-03-01", "memory-2025-03-01"
  const isoMatch = name.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}T00:00:00Z`;
  }

  // Match compact "20250301" — anchored to avoid false positives on long digit runs
  const compactMatch = name.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}T00:00:00Z`;
  }

  return undefined;
}
