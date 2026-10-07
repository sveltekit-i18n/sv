// How `run.ts` reads a row of this tree against the same row of its base,
// apart from the run so the suite can pin it. Node runs it as it is.

/**
 * What a row measures, which decides how a difference is read:
 * - `size`: bytes. The same on every machine, but most changes of what is
 *   bundled grow one, so a growth is flagged for review.
 * - `time`: milliseconds, which vary from run to run: a difference counts only
 *   beyond the spread of the samples and by at least a share of the median.
 */
export type Kind = 'size' | 'time';

export type Flag = '' | 'grew, review' | 'shrank' | 'slower, review' | 'faster';

// A time counts as changed only beyond the spread of both sides and by this
// share of master's median or more.
export const THRESHOLD = 0.05;

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);

export const median = (values: number[]) => {
  const ordered = sorted(values);
  const middle = ordered.length >> 1;

  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

/**
 * The spread of the samples of a time: their range once a quarter of them,
 * rounded down, is dropped at each end. A process that shared the machine
 * with a busy neighbour lands at an end, so it cannot widen the spread and
 * hide a change.
 */
export const spreadOf = (values: number[]): [number, number] => {
  const ordered = sorted(values);
  const dropped = ordered.length >> 2;

  return [ordered[dropped], ordered[ordered.length - 1 - dropped]];
};

/** The change from `from` to `to`, as a share of `from`. */
export const change = (from: number, to: number) => (from === 0 ? (to === 0 ? 0 : Infinity) : (to - from) / Math.abs(from));

/** How a row reads, from the samples of both sides. */
export const flagOf = (kind: Kind, master: number[], head: number[]): Flag => {
  const [from, to] = [median(master), median(head)];

  if (kind === 'size') return to > from ? 'grew, review' : to < from ? 'shrank' : '';

  const [[masterLow, masterHigh], [headLow, headHigh]] = [spreadOf(master), spreadOf(head)];
  const share = change(from, to);

  if (headLow > masterHigh && share >= THRESHOLD) return 'slower, review';

  return headHigh < masterLow && share <= -THRESHOLD ? 'faster' : '';
};
