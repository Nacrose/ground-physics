"use client";

import dynamic from "next/dynamic";

const SphLab = dynamic(() => import("@/components/SphLab"), {
  ssr: false,
  loading: () => (
    <div style={{ display: "grid", placeItems: "center", height: "100vh", background: "#111827", color: "#38bdf8", fontFamily: "system-ui" }}>
      <div>Loading 3D SPH Fluid Simulator…</div>
    </div>
  ),
});

export default function SphPage() {
  return <SphLab />;
}
