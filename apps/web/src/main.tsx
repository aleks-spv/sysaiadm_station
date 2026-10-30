import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router";
import "./index.css";
import { router } from "./App";
import { applyPrefs } from "./lib/prefs";
import { applyTheme, currentTheme } from "./theme";

applyTheme(currentTheme());
applyPrefs();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
