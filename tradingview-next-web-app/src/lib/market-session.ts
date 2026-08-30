import { DateTime } from "luxon";

export const NY_TZ = "America/New_York";
export const RTH_SESSION = "0930-1600";

export const RTH_OPEN_MINUTES = 9 * 60 + 30;
export const RTH_CLOSE_MINUTES = 16 * 60;

export type OhlcvBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export function toNewYorkTime(timeMs: number): DateTime {
  return DateTime.fromMillis(timeMs, { zone: "utc" }).setZone(NY_TZ);
}

export function isUsRthBar(timeMs: number): boolean {
  const ny = toNewYorkTime(timeMs);

  if (!ny.isValid || ny.weekday > 5) {
    return false;
  }

  const minutes = ny.hour * 60 + ny.minute;

  return minutes >= RTH_OPEN_MINUTES && minutes < RTH_CLOSE_MINUTES;
}

export function filterUsRthBars<T extends { time: number }>(bars: T[]): T[] {
  return bars.filter((bar) => isUsRthBar(bar.time));
}

export function formatNewYorkTime(
  timeMs: number,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    dateStyle: "medium",
    timeStyle: "medium",
    ...options,
  }).format(new Date(timeMs));
}
