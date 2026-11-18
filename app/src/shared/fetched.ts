export type Fetched<T> = { kind: "reading" } | { kind: "unanswered" } | { kind: "read"; value: T };

export const READING: Fetched<never> = { kind: "reading" };

export const answered = <T>(v: T | null): Fetched<T> => (v === null ? { kind: "unanswered" } : { kind: "read", value: v });

export const valueOf = <T>(f: Fetched<T>): T | null => (f.kind === "read" ? f.value : null);
