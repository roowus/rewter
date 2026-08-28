import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");

// StrictMode double-mounts effects in development, which is exactly the case
// the store's single-socket guard exists for — worth keeping the pressure on.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
