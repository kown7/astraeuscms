// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  base: process.env.ASTRO_BASE ?? '/',

  vite: {
      define: {
          global: 'globalThis',
      },
      resolve: {
          alias: {
              buffer: 'buffer/',
          },
      },
	},

  adapter: cloudflare( { session: false } ),
});