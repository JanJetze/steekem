/// <reference types="astro/client" />

// Injected at build time by vite.define in astro.config.mjs.
declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;
declare const __BUILD_RUN_URL__: string | null;
