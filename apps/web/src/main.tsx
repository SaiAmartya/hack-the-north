import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import { GameApp } from "./game/GameApp";
const PhoneWand = lazy(() =>
  import("./phone/PhoneWand").then((m) => ({ default: m.PhoneWand })),
);

const QaLab =
  import.meta.env.VITE_WAND_QA === "1"
    ? lazy(() =>
        import("./duel/DeviceLab").then((m) => ({ default: m.DeviceLab })),
      )
    : undefined;
const QaGame =
  import.meta.env.VITE_WAND_QA === "1"
    ? lazy(() => import("./qa/GameQa").then((m) => ({ default: m.GameQa })))
    : undefined;
const view =
  location.pathname === "/phone" ? (
    <Suspense fallback={null}>
      <PhoneWand />
    </Suspense>
  ) : location.pathname === "/__qa/device-lab" && QaLab ? (
    <Suspense fallback={null}>
      <QaLab />
    </Suspense>
  ) : location.pathname === "/__qa/game" && QaGame ? (
    <Suspense fallback={null}>
      <QaGame />
    </Suspense>
  ) : (
    <GameApp />
  );

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

ReactDOM.createRoot(root).render(<React.StrictMode>{view}</React.StrictMode>);
