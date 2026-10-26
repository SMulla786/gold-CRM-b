import { appendFile, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { businessDayISO } from '../shared/date';

/** Mirrors console.log / console.error into logs/app-YYYY-MM-DD.log and logs/error-YYYY-MM-DD.log (new file each IST day).
 *  shortcut: no size cap or auto-delete of old files; add logrotate (or a cleanup cron) on the server. */
export function enableFileLogs(dir = join(process.cwd(), 'logs')) {
  mkdirSync(dir, { recursive: true });
  const tee = (name: 'app' | 'error', orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    orig(...args);
    const file = join(dir, `${name}-${businessDayISO()}.log`);
    appendFile(file, format(...args) + '\n', () => {}); // a failed log write must never crash the API
  };
  console.log = tee('app', console.log.bind(console));
  console.error = tee('error', console.error.bind(console));
}
