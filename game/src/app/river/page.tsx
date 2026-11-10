"use client";

import dynamic from "next/dynamic";

const RiverLab = dynamic(() => import("@/components/RiverLab"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        height: "100vh",
        background: "#1a1816",
        color: "#38bdf8",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 24, marginBottom: 8, fontWeight: 700 }}>🌊 Loading River Simulation Lab…</div>
        <div style={{ fontSize: 13, color: "#a8a29e" }}>
          Generating 80m mountain river corridor, Poly Haven PBR textures & mid-stream boulders
        </div>
      </div>
    </div>
  ),
});

export default function RiverPage() {
  return <RiverLab />;
}

