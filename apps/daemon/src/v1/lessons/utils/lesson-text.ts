/** A title as two lessons are compared by: case, punctuation and spacing ignored. */
export function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
