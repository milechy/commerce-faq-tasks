/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_R2C_API_BASE_URL?: string;
  readonly VITE_R2C_COPILOT_UI_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
