import { createApp } from './app';
import { env } from './config/env';
import { enableFileLogs } from './lib/fileLog';

enableFileLogs();

createApp().listen(env.PORT, () => console.log(`API on http://localhost:${env.PORT}`));
