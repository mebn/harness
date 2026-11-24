import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { QuickApp } from "./components/quick/quick-app";
import { isQuickWindow } from "./lib/quick";
import "./index.css";
import "./stores/theme-store"; // applies the saved theme before first render

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isQuickWindow ? <QuickApp /> : <App />}
  </React.StrictMode>,
);
