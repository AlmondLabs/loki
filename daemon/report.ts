import { logLine, type Severity } from "../core/log-line.ts";

export type Report = (message: string, severity?: Severity) => void;

export interface ReporterOptions {
  pid: number;
  write: (line: string) => void;
  now?: () => Date;
}

export function reporter({ pid, write, now = () => new Date() }: ReporterOptions): Report {
  return (message, severity = "error") => write(logLine(now(), severity, `loki-daemon[${pid}]: ${message}`));
}
