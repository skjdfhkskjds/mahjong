interface ImportMetaEnv {
  readonly VITE_ACTIVITY_MODE?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DISCORD_CLIENT_ID?: string;
  readonly VITE_MOCK_ACTOR_ID?: string;
  readonly VITE_MOCK_DISPLAY_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
