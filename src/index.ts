import { createApp } from './app';
import { env } from './config/env';

createApp().listen(env.PORT, () => console.log(`API on http://localhost:${env.PORT}`));
