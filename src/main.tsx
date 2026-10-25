import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";

import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <a className="open-source-link" href="/legal/" target="_blank" rel="noopener noreferrer">
      关于 / 开源许可
    </a>
  </StrictMode>,
);
