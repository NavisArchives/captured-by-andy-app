import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyPalette, currentPalette } from "./theme";

// Before the first paint, so the page never flashes the other palette.
applyPalette(currentPalette());
document.documentElement.dataset.mode = "photo";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
