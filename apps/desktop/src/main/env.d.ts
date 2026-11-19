/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** KLIPY app key for GIFs, baked in at build time (.env locally, a GitHub secret for releases). */
  readonly MAIN_VITE_SOURCE_KLIPY_API_KEY?: string;
}
