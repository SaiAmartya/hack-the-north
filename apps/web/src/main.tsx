import React from "react";
import ReactDOM from "react-dom/client";
import { DeviceLab } from "./duel/DeviceLab";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <DeviceLab />
  </React.StrictMode>,
);
