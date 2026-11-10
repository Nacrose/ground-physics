"use client";

import dynamic from "next/dynamic";

const StreamLab = dynamic(() => import("@/components/StreamLab"), {
  ssr: false,
  loading: () => (
    <div style={{ display: "grid", placeItems: "center", height: "100vh", background: "#0b0f12", color: "#67e8f9", fontFamily: "system-ui" }}>
      <div>Loading Shallow Water & Caustics Lab…</div>
    </div>
  ),
});

export default function StreamPage() {
  return <StreamLab />;
}
