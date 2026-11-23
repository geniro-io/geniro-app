/**
 * Why a search-model download stopped. Main decides the reason; the Settings →
 * Search page and the failure banner show the sentence below for it, so the
 * words a user reads come from one place.
 */
export const SEARCH_MODEL_FAILURE_REASONS = [
  'network',
  'not-published',
  'disk-full',
  'checksum',
  'unknown',
] as const;

export type SearchModelFailureReason =
  (typeof SEARCH_MODEL_FAILURE_REASONS)[number];

export const SEARCH_MODEL_FAILURE_SENTENCES: Record<
  SearchModelFailureReason,
  string
> = {
  'not-published': "The search model isn't published yet.",
  'disk-full': 'Not enough disk space.',
  checksum: "The download didn't match its checksum.",
  network: 'The network connection failed.',
  unknown: 'Something went wrong.',
};

/** The title of the banner a failed download posts when Settings → Search is not showing. */
export const SEARCH_MODEL_FAILED_TITLE = 'Search model download failed';
