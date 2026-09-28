"use client";

import dynamic from "next/dynamic";

// The app reads localStorage (theme, history) in its initial state, so it is rendered on the client only.
export const ClientApp = dynamic(() => import("./App").then((m) => m.App), {
  ssr: false,
  loading: () => <div className="app" />,
});
