import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { enableFileLogs } from './lib/fileLog';

enableFileLogs();

createApp().listen(env.PORT, () => logger.info(`API on http://localhost:${env.PORT}`));
