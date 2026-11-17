import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Vite configuration for the Vela playground.
 *
 * The playground lives under the `playground/` directory and provides three
 * HTML entry points:
 *   - index.html     – the landing page with links to the two demos
 *   - widget.html    – single‑chart demo (layout: false)
 *   - workspace.html – multi‑chart workspace demo
 *
 * By declaring all three files as inputs, Vite will generate a single
 * `dist-playground` output directory that contains:
 *   - index.html, widget.html, workspace.html (unchanged HTML)
 *   - assets/… (compiled JS/CSS for each page)
 *
 * The `VITE_` prefixed environment variables (e.g. VITE_TD_KEY) are resolved
 * at build time and baked into the generated JS bundles, so the resulting
 * static files can be served by any web server (nginx, CDN, etc.) without
 * needing the original `.env.local` file.
 */
export default defineConfig({
  // Use the playground folder as the Vite project root
  root: resolve(__dirname, 'playground'),

  // Build configuration – output goes to ./dist‑playground
  build: {
    outDir: resolve(__dirname, 'dist-playground'),
    rollupOptions: {
      // Declare every HTML file that should become a separate page
      input: {
        index: resolve(__dirname, 'playground/index.html'),
        widget: resolve(__dirname, 'playground/widget.html'),
        workspace: resolve(__dirname, 'playground/workspace.html'),
      },
    },
    // Optional: keep long‑term cache‑friendly filenames (default already does this)
    // assetsDir: 'assets',
    // cssCodeSplit: true,
    // sourcemap: false,
  },

  // If you have any path aliases or plugins, add them here.
  // resolve: {
  //   alias: {
  //     '@': resolve(__dirname, 'src'),
  //   },
  // },
});
