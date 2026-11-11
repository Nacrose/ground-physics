"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { StandaloneSphLab } from "@/standalone-sph/scene";
import { SimPreset, InteractionMode } from "@/standalone-sph/sphPhysics";
import { RenderMode } from "@/standalone-sph/sphRenderer";

export default function SphLab() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labRef = useRef<StandaloneSphLab | null>(null);

  const [preset, setPreset] = useState<SimPreset>("wave");
  const [renderMode, setRenderMode] = useState<RenderMode>("fluid");
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("vortex");
  const [holeOpen, setHoleOpen] = useState(false);
  const [particleCount, setParticleCount] = useState(4500);
  const [viscosity, setViscosity] = useState(0.18);
  const [stiffness, setStiffness] = useState(85.0);
  const [xsphTension, setXsphTension] = useState(0.28);
  const [forceStrength, setForceStrength] = useState(55.0);
  const [isPaused, setIsPaused] = useState(false);

  // Live Telemetry
  const [activeCount, setActiveCount] = useState(4500);
  const [avgDensity, setAvgDensity] = useState(12.0);
  const [maxSpeed, setMaxSpeed] = useState(0.0);
  const [kineticEnergy, setKineticEnergy] = useState(0.0);

  useEffect(() => {
    if (!containerRef.current) return;
    const lab = new StandaloneSphLab(containerRef.current);
    labRef.current = lab;

    const interval = setInterval(() => {
      if (labRef.current) {
        setActiveCount(labRef.current.physics.activeParticles);
        setAvgDensity(labRef.current.physics.avgDensity);
        setMaxSpeed(labRef.current.physics.maxSpeed);
        setKineticEnergy(labRef.current.physics.kineticEnergy);
      }
    }, 150);

    return () => {
      clearInterval(interval);
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

  const handleInteractionMode = (m: InteractionMode) => {
    setInteractionMode(m);
    if (labRef.current) {
      labRef.current.setInteractionMode(m);
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

  const handleXsphTension = (val: number) => {
    setXsphTension(val);
    if (labRef.current) {
      labRef.current.physics.params.xsphFactor = val;
    }
  };

  const handleForceStrength = (val: number) => {
    setForceStrength(val);
    if (labRef.current) {
      labRef.current.setInteractionStrength(val);
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
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden", background: "#0b0f19" }}>
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
          href="/river"
          style={{
            background: "rgba(17, 24, 39, 0.85)",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(56, 189, 248, 0.25)",
            color: "#38bdf8",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 12,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          🌊 River Lab (SWE + Hydraulics) &rarr;
        </Link>
        <Link
          href="/stream"
          style={{
            background: "rgba(17, 24, 39, 0.85)",
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
          💧 Stream
        </Link>
        <Link
          href="/"
          style={{
            background: "rgba(17, 24, 39, 0.85)",
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
      </div>

      {/* Floating Control HUD */}
      <div
        style={{
          position: "absolute",
          top: 18,
          left: 18,
          background: "rgba(15, 23, 42, 0.92)",
          backdropFilter: "blur(16px)",
          border: "1px solid rgba(56, 189, 248, 0.3)",
          borderRadius: 12,
          padding: "16px 20px",
          color: "#f8fafc",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 13,
          minWidth: 350,
          maxWidth: 400,
          maxHeight: "calc(100vh - 36px)",
          overflowY: "auto",
          boxShadow: "0 16px 45px rgba(0,0,0,0.7)",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.06em", color: "#38bdf8" }}>
            3D SPH // FLUID SIMULATION
          </div>
          <span style={{ fontSize: 9.5, background: "#0284c7", color: "#fff", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>
            GPGPU SPH
          </span>
        </div>

        <p style={{ margin: "0 0 10px 0", fontSize: 11, color: "#94a3b8", lineHeight: 1.4 }}>
          Inspired by <em>deni10000/Godot-3D-SPH</em>: 3D Smoothed Particle Hydrodynamics, XSPH surface tension, 3D SDF boulder collisions, and interactive force fields.
        </p>

        {/* Live Telemetry Card */}
        <div style={{ background: "rgba(30, 41, 59, 0.55)", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255, 255, 255, 0.08)", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#38bdf8", textTransform: "uppercase" }}>
              📊 SPH Telemetry & 3D SDF
            </span>
            <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "rgba(56, 189, 248, 0.2)", color: "#38bdf8", fontWeight: 600 }}>
              {activeCount} Active
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px", fontSize: 10.5 }}>
            <div>
              <span style={{ color: "#94a3b8" }}>Fluid Density (ρ):</span>{" "}
              <strong style={{ color: "#f8fafc" }}>{avgDensity.toFixed(1)} kg/m³</strong>
            </div>
            <div>
              <span style={{ color: "#94a3b8" }}>Peak Velocity:</span>{" "}
              <strong style={{ color: maxSpeed > 10 ? "#f97316" : "#38bdf8" }}>{maxSpeed.toFixed(1)} m/s</strong>
            </div>
            <div>
              <span style={{ color: "#94a3b8" }}>Kinetic Energy:</span>{" "}
              <strong style={{ color: "#f8fafc" }}>{kineticEnergy.toFixed(0)} J</strong>
            </div>
            <div>
              <span style={{ color: "#94a3b8" }}>Obstacles:</span>{" "}
              <strong style={{ color: "#4ade80" }}>3D SDF Boulders</strong>
            </div>
          </div>
        </div>

        {/* Interactive Cursor Force Tools (Distinct Visual Identity) */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "#38bdf8", textTransform: "uppercase", marginBottom: 6 }}>
            Interactive Cursor Tools (deni10000)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button
              onClick={() => handleInteractionMode("vortex")}
              style={{
                padding: "8px 8px",
                fontSize: 11,
                background: interactionMode === "vortex" ? "rgba(16, 185, 129, 0.28)" : "rgba(255,255,255,0.06)",
                border: interactionMode === "vortex" ? "1.5px solid #10b981" : "1px solid rgba(255,255,255,0.12)",
                boxShadow: interactionMode === "vortex" ? "0 0 12px rgba(16, 185, 129, 0.4)" : "none",
                borderRadius: 7,
                color: interactionMode === "vortex" ? "#34d399" : "#fff",
                fontWeight: interactionMode === "vortex" ? 700 : 500,
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>🌀 Vortex Swirl</span>
              <span style={{ fontSize: 8.5, color: "#94a3b8", fontWeight: 400 }}>Stirs whirlpools</span>
            </button>

            <button
              onClick={() => handleInteractionMode("attract")}
              style={{
                padding: "8px 8px",
                fontSize: 11,
                background: interactionMode === "attract" ? "rgba(6, 182, 212, 0.28)" : "rgba(255,255,255,0.06)",
                border: interactionMode === "attract" ? "1.5px solid #06b6d4" : "1px solid rgba(255,255,255,0.12)",
                boxShadow: interactionMode === "attract" ? "0 0 12px rgba(6, 182, 212, 0.4)" : "none",
                borderRadius: 7,
                color: interactionMode === "attract" ? "#22d3ee" : "#fff",
                fontWeight: interactionMode === "attract" ? 700 : 500,
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>🧲 Attractor Funnel</span>
              <span style={{ fontSize: 8.5, color: "#94a3b8", fontWeight: 400 }}>Pulls fluid inward</span>
            </button>

            <button
              onClick={() => handleInteractionMode("repel")}
              style={{
                padding: "8px 8px",
                fontSize: 11,
                background: interactionMode === "repel" ? "rgba(249, 115, 22, 0.28)" : "rgba(255,255,255,0.06)",
                border: interactionMode === "repel" ? "1.5px solid #f97316" : "1px solid rgba(255,255,255,0.12)",
                boxShadow: interactionMode === "repel" ? "0 0 12px rgba(249, 115, 22, 0.4)" : "none",
                borderRadius: 7,
                color: interactionMode === "repel" ? "#fb923c" : "#fff",
                fontWeight: interactionMode === "repel" ? 700 : 500,
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>💥 Repulsor Blast</span>
              <span style={{ fontSize: 8.5, color: "#94a3b8", fontWeight: 400 }}>Pushes fluid outward</span>
            </button>

            <button
              onClick={() => handleInteractionMode("emit")}
              style={{
                padding: "8px 8px",
                fontSize: 11,
                background: interactionMode === "emit" ? "rgba(59, 130, 246, 0.28)" : "rgba(255,255,255,0.06)",
                border: interactionMode === "emit" ? "1.5px solid #3b82f6" : "1px solid rgba(255,255,255,0.12)",
                boxShadow: interactionMode === "emit" ? "0 0 12px rgba(59, 130, 246, 0.4)" : "none",
                borderRadius: 7,
                color: interactionMode === "emit" ? "#60a5fa" : "#fff",
                fontWeight: interactionMode === "emit" ? 700 : 500,
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>💧 Fluid Emitter</span>
              <span style={{ fontSize: 8.5, color: "#94a3b8", fontWeight: 400 }}>Spawns fluid stream</span>
            </button>

            <button
              onClick={() => handleInteractionMode("orbit")}
              style={{
                gridColumn: "span 2",
                padding: "7px 8px",
                fontSize: 11,
                background: interactionMode === "orbit" ? "rgba(251, 191, 36, 0.25)" : "rgba(255,255,255,0.06)",
                border: interactionMode === "orbit" ? "1.5px solid #fbbf24" : "1px solid rgba(255,255,255,0.12)",
                boxShadow: interactionMode === "orbit" ? "0 0 10px rgba(251, 191, 36, 0.35)" : "none",
                borderRadius: 7,
                color: interactionMode === "orbit" ? "#fcd34d" : "#fff",
                fontWeight: interactionMode === "orbit" ? 700 : 500,
                cursor: "pointer",
                textAlign: "center",
              }}
            >
              🎥 Orbit Camera (Free Rotation • Shift-Click to interact)
            </button>
          </div>

          <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 5, fontStyle: "italic" }}>
            *Click or drag anywhere in the 3D crater to apply real-time forces!
          </div>
        </div>

        {/* Simulation Presets */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#38bdf8", textTransform: "uppercase", marginBottom: 6 }}>
            Simulation Scenarios & Physics Presets
          </div>

          {/* User Requested Scenarios */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
            <button
              onClick={() => handlePreset("river")}
              style={{
                gridColumn: "span 2",
                padding: "9px 8px",
                fontSize: 11.5,
                background: preset === "river" ? "linear-gradient(135deg, rgba(6, 182, 212, 0.35), rgba(59, 130, 246, 0.35))" : "rgba(255,255,255,0.06)",
                border: preset === "river" ? "1.5px solid #38bdf8" : "1px solid rgba(255,255,255,0.1)",
                boxShadow: preset === "river" ? "0 0 16px rgba(56, 189, 248, 0.45)" : "none",
                borderRadius: 7,
                color: preset === "river" ? "#38bdf8" : "#fff",
                fontWeight: preset === "river" ? 700 : 500,
                cursor: "pointer",
                textAlign: "center",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <span>🏞️ 3D Mountain River (Continuous Flow & Rapids)</span>
            </button>

            <button
              onClick={() => handlePreset("ditch")}
              style={{
                padding: "8px 6px",
                fontSize: 10.5,
                background: preset === "ditch" ? "rgba(56, 189, 248, 0.28)" : "rgba(255,255,255,0.06)",
                border: preset === "ditch" ? "1.5px solid #38bdf8" : "1px solid rgba(255,255,255,0.1)",
                boxShadow: preset === "ditch" ? "0 0 12px rgba(56, 189, 248, 0.35)" : "none",
                borderRadius: 6,
                color: preset === "ditch" ? "#38bdf8" : "#fff",
                fontWeight: preset === "ditch" ? 700 : 500,
                cursor: "pointer",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>🥣 Ditch Overflow</span>
              <span style={{ fontSize: 8, color: "#94a3b8" }}>Rain & Weir Spill</span>
            </button>

            <button
              onClick={() => handlePreset("bottle")}
              style={{
                padding: "8px 6px",
                fontSize: 10.5,
                background: preset === "bottle" ? "rgba(168, 85, 247, 0.28)" : "rgba(255,255,255,0.06)",
                border: preset === "bottle" ? "1.5px solid #a855f7" : "1px solid rgba(255,255,255,0.1)",
                boxShadow: preset === "bottle" ? "0 0 12px rgba(168, 85, 247, 0.35)" : "none",
                borderRadius: 6,
                color: preset === "bottle" ? "#c084fc" : "#fff",
                fontWeight: preset === "bottle" ? 700 : 500,
                cursor: "pointer",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>🧴 Bottle Slosh</span>
              <span style={{ fontSize: 8, color: "#94a3b8" }}>Glass Enclosure</span>
            </button>

            <button
              onClick={() => handlePreset("tanker")}
              style={{
                gridColumn: "span 2",
                padding: "8px 6px",
                fontSize: 10.5,
                background: preset === "tanker" ? "rgba(245, 158, 11, 0.28)" : "rgba(255,255,255,0.06)",
                border: preset === "tanker" ? "1.5px solid #f59e0b" : "1px solid rgba(255,255,255,0.1)",
                boxShadow: preset === "tanker" ? "0 0 12px rgba(245, 158, 11, 0.35)" : "none",
                borderRadius: 6,
                color: preset === "tanker" ? "#fbbf24" : "#fff",
                fontWeight: preset === "tanker" ? 700 : 500,
                cursor: "pointer",
                textAlign: "center",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <span>🚛 Tanker Dump (Torrential Spout Impact)</span>
            </button>
          </div>

          {/* Bottle Shake Action Button */}
          {preset === "bottle" && (
            <div style={{ marginBottom: 8, animation: "fadeIn 0.2s ease" }}>
              <button
                onClick={() => labRef.current?.shakeBottle()}
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  background: "linear-gradient(135deg, #7c3aed, #a855f7)",
                  border: "1.5px solid #c084fc",
                  borderRadius: 7,
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: "pointer",
                  boxShadow: "0 0 16px rgba(168, 85, 247, 0.5)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <span>📳 Shake Bottle (Slosh & Atomize)</span>
              </button>
              <div style={{ fontSize: 8.5, color: "#c084fc", marginTop: 4, textAlign: "center" }}>
                Applies 3D oscillatory acceleration a_shake(t) inside 6-wall glass bottle
              </div>
            </div>
          )}

          {/* River description */}
          {preset === "river" && (
            <div style={{ marginBottom: 8, padding: "8px 10px", background: "rgba(6, 182, 212, 0.12)", border: "1px solid rgba(6, 182, 212, 0.35)", borderRadius: 6, fontSize: 9.5, color: "#67e8f9", lineHeight: 1.4 }}>
              <strong>🏞️ 3D Mountain River:</strong> Continuous upstream springhead inflow (x = -12.8) surges down a winding bedrock canyon, splits into turbulent rapids around mid-stream boulders, and settles into a downstream tarn lake before recycling via physical catchment conservation.
            </div>
          )}

          {/* Ditch description */}
          {preset === "ditch" && (
            <div style={{ marginBottom: 8, padding: "6px 8px", background: "rgba(56, 189, 248, 0.1)", border: "1px solid rgba(56, 189, 248, 0.25)", borderRadius: 6, fontSize: 9, color: "#bae6fd" }}>
              Rain drops fall into the upper ditch bowl (y = -0.5). When depth exceeds the weir lip (x = -1.2, y = -0.8), water cascades down the cliff into the lower terrace basin (y = -3.2).
            </div>
          )}

          {/* Tanker description */}
          {preset === "tanker" && (
            <div style={{ marginBottom: 8, padding: "6px 8px", background: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: 6, fontSize: 9, color: "#fef08a" }}>
              High-volume overhead tanker spout dumping 18 drops/frame at 12 m/s impact velocity. Watch the radial shockwave crown, circular hydraulic jump, and downhill runoff stream incision.
            </div>
          )}

          {/* Additional classic benchmarks */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button
              onClick={() => handlePreset("wave")}
              style={{
                padding: "6px 8px",
                fontSize: 10.5,
                background: preset === "wave" ? "#0284c7" : "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#fff",
                fontWeight: preset === "wave" ? 600 : 400,
                cursor: "pointer",
              }}
            >
              🌊 Dam-Break Wave
            </button>
            <button
              onClick={() => handlePreset("crater")}
              style={{
                padding: "6px 8px",
                fontSize: 10.5,
                background: preset === "crater" ? "#0284c7" : "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#fff",
                fontWeight: preset === "crater" ? 600 : 400,
                cursor: "pointer",
              }}
            >
              🥣 Crater Pool
            </button>
            <button
              onClick={() => handlePreset("rain")}
              style={{
                padding: "6px 8px",
                fontSize: 10.5,
                background: preset === "rain" ? "#0284c7" : "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#fff",
                fontWeight: preset === "rain" ? 600 : 400,
                cursor: "pointer",
              }}
            >
              🌧️ Inflow Rain
            </button>
            <button
              onClick={() => handlePreset("jet")}
              style={{
                padding: "6px 8px",
                fontSize: 10.5,
                background: preset === "jet" ? "#0284c7" : "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "#fff",
                fontWeight: preset === "jet" ? 600 : 400,
                cursor: "pointer",
              }}
            >
              ⚡ High-Speed Jet
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
              background: holeOpen ? "rgba(239, 68, 68, 0.25)" : "rgba(255,255,255,0.06)",
              border: holeOpen ? "1px solid #ef4444" : "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
              color: holeOpen ? "#fca5a5" : "#e2e8f0",
              fontWeight: 600,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {holeOpen ? "🕳️ Drain Hole: OPEN (Draining)" : "🕳️ Drain Hole: CLOSED"}
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
                fontWeight: renderMode === "fluid" ? 600 : 400,
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
                fontWeight: renderMode === "particles" ? 600 : 400,
              }}
            >
              SPH Particles
            </button>
          </div>
        </div>

        {/* Sliders */}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5 }}>
            <span style={{ color: "#cbd5e1" }}>Particles ($N$):</span>
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

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5 }}>
            <span style={{ color: "#cbd5e1" }}>Cursor Force Strength:</span>
            <span style={{ color: "#38bdf8", fontWeight: 600 }}>{forceStrength.toFixed(0)} N</span>
          </label>
          <input
            type="range"
            min="15"
            max="120"
            step="5"
            value={forceStrength}
            onChange={(e) => handleForceStrength(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#38bdf8" }}
          />

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5 }}>
            <span style={{ color: "#cbd5e1" }}>XSPH Surface Tension:</span>
            <span style={{ color: "#38bdf8", fontWeight: 600 }}>{xsphTension.toFixed(2)}</span>
          </label>
          <input
            type="range"
            min="0.00"
            max="0.55"
            step="0.02"
            value={xsphTension}
            onChange={(e) => handleXsphTension(parseFloat(e.target.value))}
            style={{ width: "100%", accentColor: "#38bdf8" }}
          />

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5 }}>
            <span style={{ color: "#cbd5e1" }}>Viscosity (μ):</span>
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

          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5 }}>
            <span style={{ color: "#cbd5e1" }}>Pressure Stiffness ($k$):</span>
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
              background: isPaused ? "#16a34a" : "#334155",
              border: "1px solid rgba(255,255,255,0.15)",
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
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              color: "#e2e8f0",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Reset
          </button>
        </div>

        <div style={{ marginTop: 10, fontSize: 10, color: "#64748b", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8 }}>
          Rotate: Left click drag in Orbit mode • Zoom: Scroll • Pan: Right click drag
        </div>
      </div>
    </div>
  );
}
