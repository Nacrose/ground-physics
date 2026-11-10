"use client";

import React, { useEffect, useRef, useState } from "react";
import { StandaloneStreamLab, ViewMode } from "@/standalone-stream/scene";

export default function StreamLab() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labRef = useRef<StandaloneStreamLab | null>(null);

  const [inflowSpeed, setInflowSpeed] = useState(0.6);
  const [inflowDepth, setInflowDepth] = useState(0.10);
  const [causticsStrength, setCausticsStrength] = useState(3.0);
  const [foamGen, setFoamGen] = useState(2.0);
  const [absorbScale, setAbsorbScale] = useState(3.5);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const lab = new StandaloneStreamLab(containerRef.current);
    labRef.current = lab;

    return () => {
      lab.dispose();
      labRef.current = null;
    };
  }, []);

  const handleInflowSpeed = (val: number) => {
    setInflowSpeed(val);
    if (labRef.current) labRef.current.simulation.params.inflowSpeed = val;
  };

  const handleInflowDepth = (val: number) => {
    setInflowDepth(val);
    if (labRef.current) labRef.current.simulation.params.inflowDepth = val;
  };

  const handleCaustics = (val: number) => {
    setCausticsStrength(val);
    if (labRef.current) labRef.current.caustics.intensity = val;
  };

  const handleFoam = (val: number) => {
    setFoamGen(val);
    if (labRef.current) labRef.current.simulation.params.foamGen = val;
  };

  const handleAbsorb = (val: number) => {
    setAbsorbScale(val);
    if (labRef.current) labRef.current.waterMat.uniforms.uAbsorbScale.value = val;
  };

  const togglePause = () => {
    setIsPaused(!isPaused);
    if (labRef.current) labRef.current.isPaused = !isPaused;
  };

  const resetSim = () => {
    if (labRef.current) {
      labRef.current.reset();
    }
  };

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden", background: "#2a2420" }}>
      {/* 3D WebGL Canvas */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Floating Control HUD */}
      <div
        style={{
          position: "absolute",
          top: 18,
          left: 18,
          background: "rgba(18, 16, 14, 0.88)",
          backdropFilter: "blur(14px)",
          border: "1px solid rgba(255, 230, 200, 0.15)",
          borderRadius: 12,
          padding: "16px 20px",
          color: "#f1ede6",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 13,
          minWidth: 320,
          boxShadow: "0 12px 36px rgba(0,0,0,0.55)",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.06em", color: "#ffd080" }}>
            STREAM // HYDRO LAB
          </div>
          <span style={{ fontSize: 10, background: "#d97706", color: "#fff", padding: "2px 6px", borderRadius: 4, fontWeight: 600 }}>
            STANDALONE
          </span>
        </div>

        <p style={{ margin: "0 0 14px 0", fontSize: 11, color: "#a8a29e", lineHeight: 1.4 }}>
          Exact recreation of <em>stream.mulualem.com</em>: 3.0m pebble diorama, 2D SWE, Poly Haven PBR, Beer-Lambert spectral absorption, screen-space refraction, and ray caustics.
        </p>

        {/* Sliders */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Inflow Velocity:</span>
            <span style={{ color: "#ffd080", fontWeight: 600 }}>{inflowSpeed.toFixed(2)} m/s</span>
          </label>
          <input
            type="range"
            min="0.2"
            max="1.5"
            step="0.05"
            value={inflowSpeed}
            onChange={(e) => handleInflowSpeed(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#ffd080" }}
          />

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Water Depth:</span>
            <span style={{ color: "#38bdf8", fontWeight: 600 }}>{(inflowDepth * 100).toFixed(0)} cm</span>
          </label>
          <input
            type="range"
            min="0.04"
            max="0.25"
            step="0.01"
            value={inflowDepth}
            onChange={(e) => handleInflowDepth(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#38bdf8" }}
          />

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Caustics Intensity:</span>
            <span style={{ color: "#fbbf24", fontWeight: 600 }}>{causticsStrength.toFixed(1)}x</span>
          </label>
          <input
            type="range"
            min="0.0"
            max="6.0"
            step="0.2"
            value={causticsStrength}
            onChange={(e) => handleCaustics(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#fbbf24" }}
          />

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Foam Generation:</span>
            <span style={{ color: "#f87171", fontWeight: 600 }}>{foamGen.toFixed(1)}x</span>
          </label>
          <input
            type="range"
            min="0.0"
            max="4.0"
            step="0.2"
            value={foamGen}
            onChange={(e) => handleFoam(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#f87171" }}
          />

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Spectral Absorption:</span>
            <span style={{ color: "#4ade80", fontWeight: 600 }}>{absorbScale.toFixed(1)}</span>
          </label>
          <input
            type="range"
            min="1.0"
            max="6.0"
            step="0.2"
            value={absorbScale}
            onChange={(e) => handleAbsorb(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#4ade80" }}
          />
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button
            onClick={togglePause}
            style={{
              flex: 1,
              padding: "7px 10px",
              background: isPaused ? "#16a34a" : "#475569",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontWeight: 600,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {isPaused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button
            onClick={resetSim}
            style={{
              padding: "7px 12px",
              background: "rgba(255,255,255,0.12)",
              border: "none",
              borderRadius: 6,
              color: "#e2e8f0",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Reset
          </button>
          <a
            href="/"
            style={{
              padding: "7px 12px",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              color: "#94a3b8",
              fontSize: 11,
              textDecoration: "none",
              display: "flex",
              alignItems: "center",
            }}
          >
            Game &rarr;
          </a>
        </div>

        <div style={{ marginTop: 12, fontSize: 10, color: "#78716c", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8 }}>
          Left drag to rotate camera • Right drag to pan • Scroll to zoom
        </div>
      </div>
    </div>
  );
}
