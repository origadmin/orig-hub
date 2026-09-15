import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, useStore } from "./store/useStore";
import { applyLanguage } from "./i18n";
import "./styles.css";

// 启动即应用持久化主题（含 system 跟随），避免闪烁
applyTheme(useStore.getState().settings.theme);
// 同步界面语言到 <html lang>
applyLanguage();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
