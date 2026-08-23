import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../app/app.js";
import "../styles/global.css";
import {
  readBrowserRuntimeConfig,
  RuntimeConfigurationError,
} from "./runtime-config.js";

function ConfigurationFailure({ error }: { readonly error: unknown }) {
  const message =
    error instanceof RuntimeConfigurationError
      ? error.message
      : "The Activity could not read its runtime configuration.";

  return (
    <main className="configuration-failure">
      <p className="eyebrow">Configuration error</p>
      <h1>Mahjong Table could not start.</h1>
      <p>{message}</p>
    </main>
  );
}

const rootElement = document.querySelector<HTMLElement>("#root");
if (!rootElement) {
  throw new Error("The Activity root element is missing.");
}

const root = createRoot(rootElement);
try {
  const config = readBrowserRuntimeConfig();
  root.render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
} catch (error) {
  root.render(<ConfigurationFailure error={error} />);
}
