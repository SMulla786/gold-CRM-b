import { appendFile, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { format } from 'node:util';
import winston from 'winston';
import { logger } from '../config/logger';
import { businessDayISO, istTimestamp } from '../shared/date';

/** One JSON line per entry: `{ t, ...fields }`, or `{ t, level, msg }` for plain messages. */
const json = winston.format.printf((info) =>
  JSON.stringify({ t: istTimestamp(), ...((info.fields as object | undefined) ?? { level: info.level, msg: info.message }) }),
);
/** Error-handler entries (meta `errorLog: true`) go to the error file only; everything else to the app file. */
const fileFormat = (errors: boolean) => winston.format.combine(winston.format((info) => (Boolean(info.errorLog) === errors ? info : false))(), json);

/** Mirrors logs into logs/app-YYYY-MM-DD.log and logs/error-YYYY-MM-DD.log (new file each IST day) as JSON lines;
 *  the terminal keeps the readable format. Stray console.log / console.error (Prisma etc.) are mirrored as plain text.
 *  shortcut: no size cap or auto-delete of old files; add logrotate (or a cleanup cron) on the server. */
export function enableFileLogs(dir = join(process.cwd(), 'logs')) {
  mkdirSync(dir, { recursive: true });
  // a failed log write must never crash the API
  const write = (name: 'app' | 'error', text: string) => appendFile(join(dir, `${name}-${businessDayISO()}.log`), text, () => {});
  const daily = (name: 'app' | 'error') => new Writable({ write(chunk, _enc, cb) { write(name, String(chunk)); cb(); } });

  logger.add(new winston.transports.Stream({ stream: daily('app'), format: fileFormat(false) }));
  logger.add(new winston.transports.Stream({ stream: daily('error'), format: fileFormat(true) }));

  const tee = (name: 'app' | 'error', orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    orig(...args);
    write(name, format(...args) + '\n');
  };
  console.log = tee('app', console.log.bind(console));
  console.error = tee('error', console.error.bind(console));
}
