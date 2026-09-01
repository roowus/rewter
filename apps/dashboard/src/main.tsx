import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { bootstrapInternalKey } from "./internalKey.js";
import "./styles.css";

// Before anything fetches: a `?key=` in the URL becomes the cookie every
// `/internal` call (and the WS upgrade) rides when the daemon wants a key.
bootstrapInternalKey();

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");

// StrictMode double-mounts effects in development, which is exactly the case
// the store's single-socket guard exists for — worth keeping the pressure on.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
