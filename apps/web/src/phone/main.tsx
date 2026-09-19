import React from "react";
import ReactDOM from "react-dom/client";
import { PhoneWand } from "./PhoneWand";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const roomId = new URL(location.href).searchParams.get("room") ?? "";
const hosted =
  import.meta.env.VITE_HOSTED_PHONE_BUILD === "1" || roomId.length > 0;
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {hosted ? <PhoneWand mode="hosted" roomId={roomId} /> : <PhoneWand />}
  </React.StrictMode>,
);
