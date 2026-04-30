import { defineConfig, fontProviders } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://council.armstr.ng',
  integrations: [],
  fonts: [
    {
      name: 'Inter',
      cssVariable: '--font-inter',
      provider: fontProviders.google(),
      weights: ['400 600'],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['system-ui', 'sans-serif']
    },
    {
      name: 'Geist Mono',
      cssVariable: '--font-geist-mono',
      provider: fontProviders.local(),
      fallbacks: ['ui-monospace', 'monospace'],
      options: {
        variants: [
          {
            weight: 400,
            style: 'normal',
            src: ['./src/assets/fonts/GeistMono-Variable.woff2']
          }
        ]
      }
    }
  ],
  vite: {
    plugins: [tailwindcss()]
  },
  adapter: cloudflare({
    imageService: { build: 'compile', runtime: 'cloudflare-binding' }
  })
});
