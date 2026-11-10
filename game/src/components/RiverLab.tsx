"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { StandaloneRiverLab } from "@/standalone-river/scene";

export default function RiverLab() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labRef = useRef<StandaloneRiverLab | null>(null);

  const [flowSpeed, setFlowSpeed] = useState(3.2);
  const [clarity, setClarity] = useState(3.5);
  const [sprayEnabled, setSprayEnabled] = useState(true);
  const [pebblesEnabled, setPebblesEnabled] = useState(true);
  const [followRiver, setFollowRiver] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [activePreset, setActivePreset] = useState<string>("rapids");

  useEffect(() => {
    if (!containerRef.current) return;
    const lab = new StandaloneRiverLab(containerRef.current);
    labRef.current = lab;

    return () => {
      lab.dispose();
      labRef.current = null;
    };
  }, []);

  const handleFlowSpeed = (val: number) => {
    setFlowSpeed(val);
    if (labRef.current) labRef.current.setFlowSpeed(val);
  };

  const handleClarity = (val: number) => {
    setClarity(val);
    if (labRef.current) labRef.current.setClarity(val);
  };

  const handleSprayToggle = (val: boolean) => {
    setSprayEnabled(val);
    if (labRef.current) labRef.current.setSpray(val);
  };

  const handlePebblesToggle = (val: boolean) => {
    setPebblesEnabled(val);
    if (labRef.current) labRef.current.setPebbles(val);
  };

  const handleFollowToggle = (val: boolean) => {
    setFollowRiver(val);
    if (labRef.current) labRef.current.setFollowRiver(val);
  };

  const handlePreset = (preset: "rapids" | "island" | "canyon" | "overview") => {
    setActivePreset(preset);
    setFollowRiver(false);
    if (labRef.current) labRef.current.setViewPreset(preset);
  };

  const togglePause = () => {
    const next = !isPaused;
    setIsPaused(next);
    if (labRef.current) labRef.current.isPaused = next;
  };

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden", background: "#1a1816" }}>
      {/* 3D WebGL Canvas */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Navigation Bar */}
      <div
        style={{
          position: "absolute",
          top: 18,
          right: 18,
          display: "flex",
          gap: 8,
          zIndex: 10,
        }}
      >
        <Link
          href="/"
          style={{
            background: "rgba(20, 18, 16, 0.85)",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(255, 230, 200, 0.15)",
            color: "#e2d9ce",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 12,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          🎮 Main Game
        </Link>
        <Link
          href="/stream"
          style={{
            background: "rgba(20, 18, 16, 0.85)",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(255, 230, 200, 0.15)",
            color: "#e2d9ce",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 12,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          💧 Stream (3m Diorama)
        </Link>
        <Link
          href="/sph"
          style={{
            background: "rgba(20, 18, 16, 0.85)",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(255, 230, 200, 0.15)",
            color: "#e2d9ce",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 12,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          ⚡ 3D SPH Lab
        </Link>
      </div>

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
          minWidth: 340,
          maxWidth: 400,
          boxShadow: "0 12px 36px rgba(0,0,0,0.55)",
          userSelect: "none",
          maxHeight: "calc(100vh - 36px)",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.06em", color: "#38bdf8" }}>
            RIVER // HYDRO VALLEY
          </div>
          <span style={{ fontSize: 10, background: "#0284c7", color: "#fff", padding: "2px 6px", borderRadius: 4, fontWeight: 600 }}>
            STANDALONE 80m
          </span>
        </div>

        <p style={{ margin: "0 0 14px 0", fontSize: 11, color: "#a8a29e", lineHeight: 1.4 }}>
          Hybrid river architecture scaling fluid simulation: 80m mountain corridor, Poly Haven Ganges pebbles & rock PBR, dual-phase flow ripples, Beer-Lambert spectral absorption, mid-stream rapids boulders, and 3D SPH airborne spray droplets.
        </p>

        {/* Camera Views */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#38bdf8", textTransform: "uppercase", marginBottom: 6 }}>
            Camera Viewpoints
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button
              onClick={() => handlePreset("rapids")}
              style={{
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: !followRiver && activePreset === "rapids" ? "#0284c7" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 11,
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              🌊 Rapids Chute
            </button>
            <button
              onClick={() => handlePreset("island")}
              style={{
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: !followRiver && activePreset === "island" ? "#0284c7" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 11,
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              🪨 Island Rock
            </button>
            <button
              onClick={() => handlePreset("canyon")}
              style={{
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: !followRiver && activePreset === "canyon" ? "#0284c7" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 11,
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              ⛰️ Downstream
            </button>
            <button
              onClick={() => handlePreset("overview")}
              style={{
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: !followRiver && activePreset === "overview" ? "#0284c7" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 11,
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              🦅 Valley Overview
            </button>
          </div>

          <button
            onClick={() => handleFollowToggle(!followRiver)}
            style={{
              width: "100%",
              marginTop: 6,
              padding: "7px 10px",
              borderRadius: 6,
              border: "1px solid rgba(56, 189, 248, 0.4)",
              background: followRiver ? "#0284c7" : "rgba(56, 189, 248, 0.12)",
              color: followRiver ? "#fff" : "#7dd3fc",
              fontSize: 12,
              cursor: "pointer",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            {followRiver ? "⏸ Stop Tracking" : "🎥 Follow River Current"}
          </button>
        </div>

        {/* Sliders */}
        <div style={{ display: "flex", flexDirection: "column", gap: 11, marginBottom: 14 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 12 }}>
              <span style={{ color: "#d6d3d1" }}>Flow Velocity</span>
              <span style={{ color: "#38bdf8", fontWeight: 600 }}>{flowSpeed.toFixed(1)} m/s</span>
            </div>
            <input
              type="range"
              min={1.0}
              max={7.0}
              step={0.1}
              value={flowSpeed}
              onChange={(e) => handleFlowSpeed(parseFloat(e.target.value))}
              style={{ width: "100%", accentColor: "#38bdf8", cursor: "pointer" }}
            />
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 12 }}>
              <span style={{ color: "#d6d3d1" }}>Water Depth / Murkiness</span>
              <span style={{ color: "#38bdf8", fontWeight: 600 }}>{clarity.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={1.0}
              max={8.0}
              step={0.2}
              value={clarity}
              onChange={(e) => handleClarity(parseFloat(e.target.value))}
              style={{ width: "100%", accentColor: "#38bdf8", cursor: "pointer" }}
            />
          </div>
        </div>

        {/* Toggles */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={sprayEnabled}
              onChange={(e) => handleSprayToggle(e.target.checked)}
              style={{ accentColor: "#38bdf8" }}
            />
            <span>3D Airborne Spray Particles (Rapids collisions)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={pebblesEnabled}
              onChange={(e) => handlePebblesToggle(e.target.checked)}
              style={{ accentColor: "#38bdf8" }}
            />
            <span>1,200 Instanced Riverbed Pebbles</span>
          </label>
        </div>

        {/* Action Buttons */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button
            onClick={togglePause}
            style={{
              flex: 1,
              padding: "7px 12px",
              background: isPaused ? "#16a34a" : "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              color: "#fff",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {isPaused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button
            onClick={() => {
              handleFlowSpeed(3.2);
              handleClarity(3.5);
              handleSprayToggle(true);
              handlePebblesToggle(true);
              handlePreset("rapids");
            }}
            style={{
              padding: "7px 12px",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              color: "#d6d3d1",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Reset Defaults
          </button>
        </div>

        {/* Technical Specs Footer */}
        <div
          style={{
            borderTop: "1px solid rgba(255, 230, 200, 0.1)",
            paddingTop: 10,
            fontSize: 10,
            color: "#78716c",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "4px 8px",
          }}
        >
          <div>Valley Length: <strong style={{ color: "#d6d3d1" }}>80 meters</strong></div>
          <div>Elevation Drop: <strong style={{ color: "#d6d3d1" }}>6.5 meters</strong></div>
          <div>Boulders: <strong style={{ color: "#d6d3d1" }}>10 Mid-Stream</strong></div>
          <div>Pebbles: <strong style={{ color: "#d6d3d1" }}>1,200 Instanced</strong></div>
          <div>Water Shading: <strong style={{ color: "#d6d3d1" }}>Beer-Lambert + SSR</strong></div>
          <div>Spray System: <strong style={{ color: "#d6d3d1" }}>600 Droplet SPH</strong></div>
        </div>
      </div>
    </div>
  );
}
