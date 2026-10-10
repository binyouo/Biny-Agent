export function nextCron(expression: string, after: Date): Date {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) throw new Error("Cron expression must have five fields.");
  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  for (let index = 0; index < 366 * 24 * 60; index += 1) {
    const minute = start.getMinutes();
    const hour = start.getHours();
    const day = start.getDate();
    const month = start.getMonth() + 1;
    const weekday = start.getDay();
    if (
      cronField(fields[0] ?? "*", minute, 0, 59)
      && cronField(fields[1] ?? "*", hour, 0, 23)
      && cronField(fields[2] ?? "*", day, 1, 31)
      && cronField(fields[3] ?? "*", month, 1, 12)
      && cronField(fields[4] ?? "*", weekday, 0, 6)
      && start.getTime() > after.getTime()
    ) return start;
    start.setMinutes(start.getMinutes() + 1);
  }
  throw new Error("Cron expression has no occurrence within one year.");
}

function cronField(field: string, value: number, minimum: number, maximum: number): boolean {
  return field.split(",").some((part) => {
    const parts = part.split("/");
    const range = parts[0] ?? "*";
    const step = parts[1] === undefined ? 1 : Number(parts[1]);
    if (!Number.isSafeInteger(step) || step < 1) return false;
    if (range === "*") return (value - minimum) % step === 0;
    if (range.includes("-")) {
      const rangeParts = range.split("-");
      const start = Number(rangeParts[0]);
      const end = Number(rangeParts[1]);
      return Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end && (value - start) % step === 0;
    }
    return Number(range) === value;
  }) && value >= minimum && value <= maximum;
}
