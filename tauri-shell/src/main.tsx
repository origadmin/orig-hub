import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, useStore } from "./store/useStore";
import "./styles.css";

// 启动即应用持久化主题（含 system 跟随），避免闪烁
applyTheme(useStore.getState().settings.theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
