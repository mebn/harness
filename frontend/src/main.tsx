import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./stores/theme-store"; // applies the saved theme before first render

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
