"use client";

import dynamic from "next/dynamic";

const GameCanvas = dynamic(() => import("@/components/GameCanvas"), {
  ssr: false,
  loading: () => (
    <div className="game-root">
      <div className="game-boot-fallback">
        <div className="hud-boot-title">STORMCOUNTRY</div>
        <div className="hud-boot-sub">loading the engine…</div>
      </div>
    </div>
  ),
});

export default function Home() {
  return <GameCanvas />;
}
