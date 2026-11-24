export type Severity = "info" | "warning" | "error";

/** A line of `~/.loki/logs/daemon.log` and `~/.loki/mod.log`: the time in UTC, the severity, then the message. */
export const logLine = (at: Date, severity: Severity, message: string): string => `${at.toISOString()} ${severity} ${message}`;
