/**
 * Debug logger. Never emits full base64: only mime, byte size and sha256 are
 * ever interpolated by callers, and any stray long base64 run is masked here as
 * a second line of defence.
 */

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/g;

export function maskBase64(text: string): string {
  return text.replace(BASE64_RUN, (m) => `<base64:${m.length}chars>`);
}

export function createLogger(enabled: boolean, sink: (line: string) => void = console.error): Logger {
  const emit = (level: string, message: string) => {
    if (!enabled && level === "debug") return;
    sink(`[vision] ${level} ${maskBase64(message)}`);
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
  };
}
