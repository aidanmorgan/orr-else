export interface Clock {
  now(): number;
  date(timestampMs?: number): Date;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  date: (timestampMs?: number) => timestampMs === undefined ? new Date() : new Date(timestampMs)
};
