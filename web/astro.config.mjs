import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://council.armstr.ng',
  integrations: [],
  adapter: cloudflare()
});