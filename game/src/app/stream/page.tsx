"use client";

import React, { useEffect, useState } from "react";

export default function StreamPage() {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setQuery(window.location.search);
    }
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden", margin: 0, padding: 0, background: "#0b0f12" }}>
      <iframe
        src={`/stream/index.html${query || "?gui=1"}`}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          display: "block",
        }}
        title="Stream Simulation Lab"
        allow="accelerometer; camera; encrypted-media; display-capture; geolocation; gyroscope; microphone; midi; clipboard-read; clipboard-write; web-share"
      />
    </div>
  );
}
