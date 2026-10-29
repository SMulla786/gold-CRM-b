import winston from 'winston';
import { istTimestamp } from '../shared/date';
import { env } from './env';

const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) Object.assign(info, { message: info.stack });
  return info;
});

/** Terminal line: `26-10 15:43:01 info: message`. */
const line = winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`);

/** Terminal: readable coloured lines (errors to stderr). Daily files (lib/fileLog) instead write each entry's
 *  `fields` meta as JSON — pass `{ fields }` as the meta argument for anything the files should keep structured. */
export const logger = winston.createLogger({
  level: env.NODE_ENV === 'development' ? 'debug' : 'info',
  silent: env.NODE_ENV === 'test',
  format: winston.format.combine(
    winston.format((info) => {
      const t = istTimestamp(); // server clock may be UTC; always log shop time (IST)
      info.timestamp = `${t.slice(8, 10)}-${t.slice(5, 7)} ${t.slice(11, 19)}`;
      return info;
    })(),
    enumerateErrorFormat(),
    winston.format.splat(),
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
      // colour only here (transports get their own copy of each entry), so log files stay free of ANSI codes
      format: env.NODE_ENV === 'development' ? winston.format.combine(winston.format.colorize(), line) : line,
    }),
  ],
});
