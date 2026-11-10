"use client";

import React, { useEffect, useRef, useState } from "react";
import { StandaloneStreamLab, ViewMode } from "@/standalone-stream/scene";

export default function StreamLab() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labRef = useRef<StandaloneStreamLab | null>(null);

  const [inflowSpeed, setInflowSpeed] = useState(2.4);
  const [inflowDepth, setInflowDepth] = useState(0.38);
  const [causticsStrength, setCausticsStrength] = useState(2.8);
  const [foamGen, setFoamGen] = useState(2.2);
  const [absorbScale, setAbsorbScale] = useState(3.2);
  const [viewMode, setViewMode] = useState<ViewMode>("realistic");

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
    if (labRef.current) labRef.current.caustics.params.strength = val;
  };

  const handleFoam = (val: number) => {
    setFoamGen(val);
    if (labRef.current) labRef.current.simulation.params.foamGen = val;
  };

  const handleAbsorb = (val: number) => {
    setAbsorbScale(val);
    if (labRef.current) labRef.current.waterMat.uniforms.uAbsorbScale.value = val;
  };

  const handleViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    if (labRef.current) labRef.current.setViewMode(mode);
  };

  const triggerSplash = () => {
    if (labRef.current) {
      labRef.current.simulation.addDisturbance(0.35, 0.5, 0.08, 0.45);
    }
  };

  const resetSim = () => {
    if (labRef.current) {
      labRef.current.simulation.reset();
    }
  };

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden", background: "#0b0f12" }}>
      {/* 3D WebGL Canvas */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Floating Control HUD */}
      <div
        style={{
          position: "absolute",
          top: 18,
          left: 18,
          background: "rgba(12, 16, 20, 0.88)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          borderRadius: 10,
          padding: "16px 20px",
          color: "#e2e8f0",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 13,
          minWidth: 320,
          boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.08em", color: "#67e8f9" }}>
            STREAM // HYDRO LAB
          </div>
          <span style={{ fontSize: 10, background: "#0891b2", color: "#fff", padding: "2px 6px", borderRadius: 4 }}>
            STANDALONE
          </span>
        </div>

        <p style={{ margin: "0 0 14px 0", fontSize: 11, color: "#94a3b8", lineHeight: 1.4 }}>
          Inspired by <em>stream.mulualem.com</em>. GPU 2D Shallow Water Equations, ray-refracted caustics, spectral Beer-Lambert absorption, and hydrodynamic foam.
        </p>

        {/* Sliders */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Inflow Velocity:</span>
            <span style={{ color: "#38bdf8", fontWeight: 600 }}>{inflowSpeed.toFixed(1)} m/s</span>
          </label>
          <input
            type="range"
            min="0.5"
            max="5.0"
            step="0.1"
            value={inflowSpeed}
            onChange={(e) => handleInflowSpeed(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#38bdf8" }}
          />

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Water Depth:</span>
            <span style={{ color: "#38bdf8", fontWeight: 600 }}>{(inflowDepth * 100).toFixed(0)} cm</span>
          </label>
          <input
            type="range"
            min="0.15"
            max="0.80"
            step="0.02"
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

        {/* View Mode */}
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6 }}>VIEW MODE:</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => handleViewMode("realistic")}
              style={{
                flex: 1,
                padding: "6px 8px",
                fontSize: 11,
                background: viewMode === "realistic" ? "#0284c7" : "rgba(255,255,255,0.08)",
                border: "none",
                borderRadius: 4,
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Realistic Liquid
            </button>
            <button
              onClick={() => handleViewMode("caustics")}
              style={{
                flex: 1,
                padding: "6px 8px",
                fontSize: 11,
                background: viewMode === "caustics" ? "#d97706" : "rgba(255,255,255,0.08)",
                border: "none",
                borderRadius: 4,
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Caustics Focus
            </button>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button
            onClick={triggerSplash}
            style={{
              flex: 1,
              padding: "7px 10px",
              background: "#059669",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontWeight: 600,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            🌊 Drop Splash
          </button>
          <button
            onClick={resetSim}
            style={{
              padding: "7px 10px",
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
              padding: "7px 10px",
              background: "rgba(255,255,255,0.06)",
              border: "none",
              borderRadius: 6,
              color: "#94a3b8",
              fontSize: 11,
              textDecoration: "none",
              display: "flex",
              alignItems: "center",
            }}
          >
            Main Game
          </a>
        </div>
      </div>

      {/* Interaction Tips Banner */}
      <div
        style={{
          position: "absolute",
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(10, 14, 18, 0.75)",
          backdropFilter: "blur(8px)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 20,
          padding: "6px 18px",
          color: "#94a3b8",
          fontSize: 12,
          pointerEvents: "none",
        }}
      >
        Left-click & drag on water to create ripples • Right-click & drag to orbit • Scroll to zoom
      </div>
    </div>
  );
}
