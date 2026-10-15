export const DATE_FORMAT = new Intl.DateTimeFormat("es-CL", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDateTime(input: string): string {
  return DATE_FORMAT.format(new Date(input));
}

export function isPast(input: string): boolean {
  return new Date(input).getTime() < Date.now();
}

export function differenceInHours(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 3600000;
}

export function toTimeValue(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
