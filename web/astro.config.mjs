import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://council.armstr.ng',
  integrations: [],
  vite: {
    plugins: [tailwindcss()]
  },
  adapter: cloudflare({
    imageService: { build: 'compile', runtime: 'cloudflare-binding' }
  })
});
