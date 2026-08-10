// Minimal leveled logger writing to stderr (stdout is reserved for anything the
// transport might emit).

function line(level: string, msg: string): void {
  process.stderr.write(`[ybrain] ${level} ${msg}\n`);
}

export const log = {
  info: (m: string) => line("INFO", m),
  warn: (m: string) => line("WARN", m),
  error: (m: string) => line("ERR ", m),
};
