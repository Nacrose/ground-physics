"use client";

import React, { useEffect, useRef, useState } from "react";
import { StandaloneSphLab } from "@/standalone-sph/scene";
import { SimPreset } from "@/standalone-sph/sphPhysics";
import { RenderMode } from "@/standalone-sph/sphRenderer";

export default function SphLab() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labRef = useRef<StandaloneSphLab | null>(null);

  const [preset, setPreset] = useState<SimPreset>("wave");
  const [renderMode, setRenderMode] = useState<RenderMode>("fluid");
  const [holeOpen, setHoleOpen] = useState(false);
  const [particleCount, setParticleCount] = useState(4500);
  const [viscosity, setViscosity] = useState(0.18);
  const [stiffness, setStiffness] = useState(85.0);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const lab = new StandaloneSphLab(containerRef.current);
    labRef.current = lab;

    return () => {
      lab.dispose();
      labRef.current = null;
    };
  }, []);

  const handlePreset = (p: SimPreset) => {
    setPreset(p);
    setHoleOpen(false);
    if (labRef.current) {
      labRef.current.setPreset(p);
    }
  };

  const handleRenderMode = (m: RenderMode) => {
    setRenderMode(m);
    if (labRef.current) {
      labRef.current.setRenderMode(m);
    }
  };

  const handleHoleToggle = () => {
    const next = !holeOpen;
    setHoleOpen(next);
    if (labRef.current) {
      labRef.current.toggleHole(next);
    }
  };

  const handleParticleCount = (cnt: number) => {
    setParticleCount(cnt);
    if (labRef.current) {
      labRef.current.physics.params.particleCount = cnt;
      labRef.current.physics.applyPreset(preset);
    }
  };

  const handleViscosity = (val: number) => {
    setViscosity(val);
    if (labRef.current) {
      labRef.current.physics.params.viscosity = val;
    }
  };

  const handleStiffness = (val: number) => {
    setStiffness(val);
    if (labRef.current) {
      labRef.current.physics.params.stiffness = val;
    }
  };

  const togglePause = () => {
    setIsPaused(!isPaused);
    if (labRef.current) labRef.current.isPaused = !isPaused;
  };

  const reset = () => {
    if (labRef.current) labRef.current.setPreset(preset);
  };

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden", background: "#111827" }}>
      {/* 3D WebGL Canvas */}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Floating Control HUD */}
      <div
        style={{
          position: "absolute",
          top: 18,
          left: 18,
          background: "rgba(17, 24, 39, 0.90)",
          backdropFilter: "blur(14px)",
          border: "1px solid rgba(56, 189, 248, 0.25)",
          borderRadius: 12,
          padding: "16px 20px",
          color: "#f1f5f9",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 13,
          minWidth: 330,
          boxShadow: "0 14px 40px rgba(0,0,0,0.6)",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.06em", color: "#38bdf8" }}>
            MOD1 // 3D SPH FLUID LAB
          </div>
          <span style={{ fontSize: 10, background: "#0284c7", color: "#fff", padding: "2px 6px", borderRadius: 4, fontWeight: 600 }}>
            3D PARTICLES
          </span>
        </div>

        <p style={{ margin: "0 0 12px 0", fontSize: 11, color: "#94a3b8", lineHeight: 1.4 }}>
          Recreation of <em>agtdbx/mod1</em>: 3D Smoothed Particle Hydrodynamics (SPH), crater terrain interaction, breaking waves, and drain hole physics.
        </p>

        {/* Presets */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: 6 }}>
            Simulation Presets (mod1)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button
              onClick={() => handlePreset("wave")}
              style={{
                padding: "7px 8px",
                fontSize: 11,
                background: preset === "wave" ? "#0284c7" : "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#fff",
                fontWeight: preset === "wave" ? 600 : 400,
                cursor: "pointer",
              }}
            >
              🌊 Breaking Wave
            </button>
            <button
              onClick={() => handlePreset("rain")}
              style={{
                padding: "7px 8px",
                fontSize: 11,
                background: preset === "rain" ? "#0284c7" : "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#fff",
                fontWeight: preset === "rain" ? 600 : 400,
                cursor: "pointer",
              }}
            >
              🌧️ Rain Accumulation
            </button>
            <button
              onClick={() => handlePreset("crater")}
              style={{
                padding: "7px 8px",
                fontSize: 11,
                background: preset === "crater" ? "#0284c7" : "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#fff",
                fontWeight: preset === "crater" ? 600 : 400,
                cursor: "pointer",
              }}
            >
              🥣 Crater Basin
            </button>
            <button
              onClick={() => handlePreset("jet")}
              style={{
                padding: "7px 8px",
                fontSize: 11,
                background: preset === "jet" ? "#0284c7" : "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#fff",
                fontWeight: preset === "jet" ? 600 : 400,
                cursor: "pointer",
              }}
            >
              🚀 Water Jet
            </button>
          </div>
        </div>

        {/* Drain Hole Control */}
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={handleHoleToggle}
            style={{
              width: "100%",
              padding: "7px 10px",
              background: holeOpen ? "#dc2626" : "rgba(239, 68, 68, 0.15)",
              border: "1px solid #ef4444",
              borderRadius: 6,
              color: "#fff",
              fontWeight: 600,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {holeOpen ? "🕳️ Drain Hole OPEN (Draining...)" : "⭕ Open Crater Drain Hole"}
          </button>
        </div>

        {/* Render Mode */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", marginBottom: 6 }}>
            Render Mode
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => handleRenderMode("fluid")}
              style={{
                flex: 1,
                padding: "6px 8px",
                fontSize: 11,
                background: renderMode === "fluid" ? "#0d9488" : "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Physical Fluid
            </button>
            <button
              onClick={() => handleRenderMode("particles")}
              style={{
                flex: 1,
                padding: "6px 8px",
                fontSize: 11,
                background: renderMode === "particles" ? "#0d9488" : "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#fff",
                cursor: "pointer",
              }}
            >
              SPH Particles
            </button>
          </div>
        </div>

        {/* Sliders */}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Particles:</span>
            <span style={{ color: "#38bdf8", fontWeight: 600 }}>{particleCount}</span>
          </label>
          <input
            type="range"
            min="1000"
            max="8000"
            step="500"
            value={particleCount}
            onChange={(e) => handleParticleCount(parseInt(e.target.value))}
            style={{ width: "100%", accentColor: "#38bdf8" }}
          />

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Viscosity (Friction):</span>
            <span style={{ color: "#38bdf8", fontWeight: 600 }}>{viscosity.toFixed(2)}</span>
          </label>
          <input
            type="range"
            min="0.05"
            max="0.80"
            step="0.02"
            value={viscosity}
            onChange={(e) => handleViscosity(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#38bdf8" }}
          />

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Pressure Stiffness:</span>
            <span style={{ color: "#38bdf8", fontWeight: 600 }}>{stiffness.toFixed(0)}</span>
          </label>
          <input
            type="range"
            min="20"
            max="200"
            step="5"
            value={stiffness}
            onChange={(e) => handleStiffness(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#38bdf8" }}
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
            onClick={reset}
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
            href="/stream"
            style={{
              padding: "7px 10px",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              color: "#ffd080",
              fontSize: 11,
              textDecoration: "none",
              display: "flex",
              alignItems: "center",
            }}
          >
            Stream &rarr;
          </a>
        </div>

        <div style={{ marginTop: 10, fontSize: 10, color: "#64748b", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8 }}>
          Rotate: Left click drag • Zoom: Scroll • Pan: Right click drag
        </div>
      </div>
    </div>
  );
}
