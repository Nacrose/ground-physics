"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { StandaloneRiverLab } from "@/standalone-river/scene";

export default function RiverLab() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labRef = useRef<StandaloneRiverLab | null>(null);

  const [dischargeQ, setDischargeQ] = useState(22.0);
  const [clarity, setClarity] = useState(3.5);
  const [sprayEnabled, setSprayEnabled] = useState(true);
  const [foamDriftEnabled, setFoamDriftEnabled] = useState(true);
  const [pebblesEnabled, setPebblesEnabled] = useState(true);
  const [followRiver, setFollowRiver] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [activePreset, setActivePreset] = useState<string>("macro");
  const [rainIntensity, setRainIntensity] = useState(0.0); // 0 to 80 mm/h
  const [catchmentRunoffQ, setCatchmentRunoffQ] = useState(0.0);

  // Hydraulic live metrics
  const [minV, setMinV] = useState(1.6);
  const [maxV, setMaxV] = useState(5.8);
  const [minFr, setMinFr] = useState(0.5);
  const [maxFr, setMaxFr] = useState(1.4);
  const [avgDepth, setAvgDepth] = useState(0.85);
  const [channelVolume, setChannelVolume] = useState(460);
  const [channelMass, setChannelMass] = useState(460);
  const [massFlux, setMassFlux] = useState(22000);
  const [puddleStorage, setPuddleStorage] = useState(1200);
  const [rainFlux, setRainFlux] = useState(0);

  // REEF3D Sediment & Morphodynamics telemetry
  const [minTau, setMinTau] = useState(25);
  const [maxTau, setMaxTau] = useState(280);
  const [minTheta, setMinTheta] = useState(0.024);
  const [maxTheta, setMaxTheta] = useState(0.266);
  const [scourCount, setScourCount] = useState(0);
  const [bedloadFlux, setBedloadFlux] = useState(0);
  const [frontProgress, setFrontProgress] = useState(1.0);

  // MOBIDICpy Catchment Hydrology & Soil Budget telemetry
  const [soilSaturation, setSoilSaturation] = useState(0.32);
  const [infilCap, setInfilCap] = useState(48.0);
  const [aquiferStorage, setAquiferStorage] = useState(6800);
  const [qSurface, setQSurface] = useState(0.0);
  const [qInterflow, setQInterflow] = useState(0.0);
  const [qBaseflow, setQBaseflow] = useState(15.0);

  // 2D Shallow Water Equations (SWE) Interactive Waves telemetry (Chentanez & Müller 2010)
  const [sweWaveEnergy, setSweWaveEnergy] = useState(0.0);
  const [sweMaxWave, setSweMaxWave] = useState(0.0);
  const [sweImpulseCount, setSweImpulseCount] = useState(0);
  const [sweWaveSpeed, setSweWaveSpeed] = useState(2.8);
  const [interactionMode, setInteractionMode] = useState<"dropper" | "sweeper" | "orbit">("dropper");

  // Water physical model & SPH states
  const [waterModel, setWaterModel] = useState<"sph" | "surface">("surface");
  const [sphMode, setSphMode] = useState<"fluid" | "particles">("fluid");
  const [sphParticleCount, setSphParticleCount] = useState(4500);

  const updateTelemetry = (lab: StandaloneRiverLab) => {
    const hyd = lab.hydraulics;
    setMinV(hyd.minVelocity);
    setMaxV(hyd.maxVelocity);
    setMinFr(hyd.minFroude);
    setMaxFr(hyd.maxFroude);
    setAvgDepth(hyd.avgDepth);
    setCatchmentRunoffQ(lab.runoff.currentRainQ);
    setChannelVolume(hyd.totalVolume);
    setChannelMass(hyd.totalMassTonnes);
    setMassFlux(hyd.massFlowRate);
    setPuddleStorage(lab.runoff.getPuddleStorageVolume());
    setRainFlux(lab.runoff.getRainfallMassFlux());
    setMinTau(hyd.minShearStress);
    setMaxTau(hyd.maxShearStress);
    setMinTheta(hyd.minShields);
    setMaxTheta(hyd.maxShields);
    setScourCount(hyd.scourCount);
    setBedloadFlux(hyd.bedloadFluxKgS);
    setFrontProgress(lab.runoff.frontProgress);
    setSoilSaturation(lab.runoff.soilSaturation);
    setInfilCap(lab.runoff.currentInfiltrationCap);
    setAquiferStorage(lab.runoff.aquiferStorage);
    setQSurface(lab.runoff.surfaceRunoffQ);
    setQInterflow(lab.runoff.subsurfaceInterflowQ);
    setQBaseflow(lab.runoff.baseflowQ);

    if (lab.swe) {
      setSweWaveEnergy(lab.swe.waveEnergy);
      setSweMaxWave(lab.swe.maxWaveHeight);
      setSweImpulseCount(lab.swe.impulseCount);
      setSweWaveSpeed(lab.swe.avgWaveSpeed);
    }

    if (lab.sph) {
      setSphParticleCount(lab.sph.activeParticles);
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const lab = new StandaloneRiverLab(containerRef.current);
    labRef.current = lab;
    updateTelemetry(lab);

    // Periodic telemetry update to track dynamic catchment runoff swell
    const interval = setInterval(() => {
      if (labRef.current) {
        updateTelemetry(labRef.current);
      }
    }, 250);

    return () => {
      clearInterval(interval);
      lab.dispose();
      labRef.current = null;
    };
  }, []);

  const handleWaterModelChange = (model: "sph" | "surface") => {
    setWaterModel(model);
    if (labRef.current) {
      labRef.current.setWaterModel(model);
      updateTelemetry(labRef.current);
    }
  };

  const handleSphModeChange = (mode: "fluid" | "particles") => {
    setSphMode(mode);
    if (labRef.current) {
      labRef.current.setSphRenderMode(mode);
      updateTelemetry(labRef.current);
    }
  };

  const handleDischarge = (val: number) => {
    setDischargeQ(val);
    if (labRef.current) {
      labRef.current.setDischarge(val);
      updateTelemetry(labRef.current);
    }
  };

  const handleClarity = (val: number) => {
    setClarity(val);
    if (labRef.current) labRef.current.setClarity(val);
  };

  const handleSprayToggle = (val: boolean) => {
    setSprayEnabled(val);
    if (labRef.current) labRef.current.setSpray(val);
  };

  const handleFoamDriftToggle = (val: boolean) => {
    setFoamDriftEnabled(val);
    if (labRef.current) labRef.current.setFoamDrift(val);
  };

  const handlePebblesToggle = (val: boolean) => {
    setPebblesEnabled(val);
    if (labRef.current) labRef.current.setPebbles(val);
  };

  const handleFollowToggle = (val: boolean) => {
    setFollowRiver(val);
    if (labRef.current) labRef.current.setFollowRiver(val);
  };

  const handlePreset = (preset: "macro" | "rapids" | "island" | "canyon" | "overview" | "runoff") => {
    setActivePreset(preset);
    setFollowRiver(false);
    if (labRef.current) labRef.current.setViewPreset(preset);
  };

  const handleRainIntensity = (val: number) => {
    setRainIntensity(val);
    if (labRef.current) {
      labRef.current.setRainIntensity(val);
      updateTelemetry(labRef.current);
    }
  };

  const togglePause = () => {
    const next = !isPaused;
    setIsPaused(next);
    if (labRef.current) labRef.current.isPaused = next;
  };

  const handleInteractionMode = (mode: "dropper" | "sweeper" | "orbit") => {
    setInteractionMode(mode);
    if (labRef.current) labRef.current.setInteractionMode(mode);
  };

  const handleDropPebble = () => {
    if (labRef.current) {
      labRef.current.dropPebbleAtCenter();
      updateTelemetry(labRef.current);
    }
  };

  const handleSurgeWave = () => {
    if (labRef.current) {
      labRef.current.triggerSurgeWave();
      updateTelemetry(labRef.current);
    }
  };

  const handleBoulderShock = () => {
    if (labRef.current) {
      labRef.current.triggerBoulderShock();
      updateTelemetry(labRef.current);
    }
  };

  const handleClearWaves = () => {
    if (labRef.current) {
      labRef.current.clearWaves();
      updateTelemetry(labRef.current);
    }
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
          background: "rgba(18, 16, 14, 0.90)",
          backdropFilter: "blur(14px)",
          border: "1px solid rgba(56, 189, 248, 0.25)",
          borderRadius: 12,
          padding: "16px 20px",
          color: "#f1ede6",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 13,
          minWidth: 350,
          maxWidth: 420,
          boxShadow: "0 14px 40px rgba(0,0,0,0.65)",
          userSelect: "none",
          maxHeight: "calc(100vh - 36px)",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "0.06em", color: "#38bdf8" }}>
            SAINT-VENANT // RIVER HYDRAULICS
          </div>
          <span style={{ fontSize: 10, background: "#0284c7", color: "#fff", padding: "2px 6px", borderRadius: 4, fontWeight: 600 }}>
            FLUID DYNAMICS
          </span>
        </div>

        <p style={{ margin: "0 0 12px 0", fontSize: 11, color: "#a8a29e", lineHeight: 1.4 }}>
          Continuity equation ($Q = A \cdot v$) and Manning&apos;s formula solver across 80m. Channel constrictions by mid-stream boulders squeeze cross-sectional area, accelerating local velocity and triggering supercritical hydraulic jumps ($Fr &gt; 1$).
        </p>

        {/* Unified Water Physical Model Selector */}
        <div
          style={{
            background: "rgba(30, 41, 59, 0.85)",
            border: "1px solid rgba(56, 189, 248, 0.4)",
            borderRadius: 8,
            padding: "10px 12px",
            marginBottom: 14,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontWeight: 700, fontSize: 11, color: "#38bdf8", textTransform: "uppercase" }}>
              Water Physical Model
            </span>
            <span
              style={{
                fontSize: 9.5,
                background: waterModel === "surface" ? "#059669" : "#0284c7",
                color: "#fff",
                padding: "2px 6px",
                borderRadius: 4,
                fontWeight: 600,
              }}
            >
              {waterModel === "surface" ? "2D SAINT-VENANT + SWE (ACTIVE)" : "3D NAVIER-STOKES SPH"}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
            <button
              onClick={() => handleWaterModelChange("surface")}
              style={{
                padding: "8px 6px",
                borderRadius: 6,
                border: waterModel === "surface" ? "1.5px solid #34d399" : "1px solid rgba(255,255,255,0.12)",
                background: waterModel === "surface" ? "rgba(16, 185, 129, 0.45)" : "rgba(255,255,255,0.06)",
                boxShadow: waterModel === "surface" ? "0 0 12px rgba(52, 211, 153, 0.45)" : "none",
                color: waterModel === "surface" ? "#34d399" : "#fff",
                fontSize: 10.5,
                cursor: "pointer",
                fontWeight: 700,
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>🏄 Continuous Surface Mesh</span>
              <span style={{ fontSize: 8.5, color: "#94a3b8", fontWeight: 400 }}>
                High-fidelity 2D SWE + Saint-Venant
              </span>
            </button>

            <button
              onClick={() => handleWaterModelChange("sph")}
              style={{
                padding: "8px 6px",
                borderRadius: 6,
                border: waterModel === "sph" ? "1.5px solid #38bdf8" : "1px solid rgba(255,255,255,0.12)",
                background: waterModel === "sph" ? "rgba(2, 132, 199, 0.45)" : "rgba(255,255,255,0.06)",
                boxShadow: waterModel === "sph" ? "0 0 12px rgba(56, 189, 248, 0.4)" : "none",
                color: waterModel === "sph" ? "#38bdf8" : "#fff",
                fontSize: 10.5,
                cursor: "pointer",
                fontWeight: 700,
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span>🌊 3D SPH Particles</span>
              <span style={{ fontSize: 8.5, color: "#94a3b8", fontWeight: 400 }}>
                {sphParticleCount} SPH particles (Experimental)
              </span>
            </button>
          </div>

          {waterModel === "sph" && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 6, borderTop: "1px dashed rgba(56, 189, 248, 0.25)" }}>
              <span style={{ fontSize: 10, color: "#94a3b8" }}>Rendering Pipeline:</span>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  onClick={() => handleSphModeChange("fluid")}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "1px solid rgba(56,189,248,0.3)",
                    background: sphMode === "fluid" ? "#0284c7" : "rgba(255,255,255,0.06)",
                    color: "#fff",
                    fontSize: 9.5,
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  💧 Smooth Fluid (SSFR)
                </button>
                <button
                  onClick={() => handleSphModeChange("particles")}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "1px solid rgba(56,189,248,0.3)",
                    background: sphMode === "particles" ? "#0284c7" : "rgba(255,255,255,0.06)",
                    color: "#fff",
                    fontSize: 9.5,
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  🔵 Raw Particles
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Live Hydraulic Telemetry Card */}
        <div
          style={{
            background: "rgba(15, 23, 42, 0.7)",
            border: "1px solid rgba(56, 189, 248, 0.25)",
            borderRadius: 8,
            padding: "10px 12px",
            marginBottom: 14,
            fontSize: 11,
          }}
        >
          <div style={{ fontWeight: 600, color: "#38bdf8", marginBottom: 6, fontSize: 11, textTransform: "uppercase" }}>
            Real-Time Hydraulic Telemetry
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px" }}>
            <div>
              <span style={{ color: "#94a3b8" }}>Discharge ($Q$):</span>{" "}
              <strong style={{ color: "#f8fafc" }}>
                {(dischargeQ + catchmentRunoffQ).toFixed(1)} m³/s
              </strong>
              {catchmentRunoffQ > 0.2 && (
                <span style={{ fontSize: 9.5, color: "#38bdf8", marginLeft: 4 }}>
                  (+{catchmentRunoffQ.toFixed(1)} runoff)
                </span>
              )}
            </div>
            <div>
              <span style={{ color: "#94a3b8" }}>Rain / Runoff:</span>{" "}
              <strong style={{ color: rainIntensity > 0 ? "#38bdf8" : "#94a3b8" }}>
                {rainIntensity.toFixed(0)} mm/h {rainIntensity > 40 ? "(Storm)" : rainIntensity > 0 ? "(Rain)" : "(Dry)"}
              </strong>
            </div>
            <div>
              <span style={{ color: "#94a3b8" }}>Velocity Range:</span>{" "}
              <strong style={{ color: "#38bdf8" }}>{minV.toFixed(1)} – {maxV.toFixed(1)} m/s</strong>
            </div>
            <div>
              <span style={{ color: "#94a3b8" }}>Froude ($Fr$):</span>{" "}
              <strong style={{ color: maxFr > 1.0 ? "#f97316" : "#4ade80" }}>
                {minFr.toFixed(2)} – {maxFr.toFixed(2)} {maxFr > 1.0 ? "(Supercritical)" : "(Subcritical)"}
              </strong>
            </div>
          </div>

          {/* Real-time Mass & Volume Accounting */}
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dashed rgba(56, 189, 248, 0.25)" }}>
            <div style={{ fontWeight: 600, color: "#38bdf8", marginBottom: 5, fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              ⚖️ Mass & Volume Accounting
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px", fontSize: 10 }}>
              <div>
                <span style={{ color: "#94a3b8" }}>Channel Storage:</span>{" "}
                <strong style={{ color: "#f8fafc" }}>{channelVolume.toFixed(1)} m³ ({channelMass.toFixed(0)} t)</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Mass Flux (ρQ):</span>{" "}
                <strong style={{ color: "#38bdf8" }}>{(massFlux / 1000).toFixed(1)} t/s ({massFlux.toFixed(0)} kg/s)</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Terrace Pools:</span>{" "}
                <strong style={{ color: "#f8fafc" }}>{puddleStorage.toFixed(0)} Litres</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Rainfall Inflow:</span>{" "}
                <strong style={{ color: rainFlux > 0 ? "#38bdf8" : "#94a3b8" }}>{rainFlux.toFixed(1)} kg/s</strong>
              </div>
            </div>
          </div>

          {/* REEF3D Sediment & Morphodynamics */}
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dashed rgba(56, 189, 248, 0.25)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
              <span style={{ fontWeight: 600, color: "#38bdf8", fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                🧱 REEF3D // Sediment Scour & Bedload
              </span>
              <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 3, background: scourCount > 0 ? "rgba(239, 68, 68, 0.25)" : "rgba(34, 197, 94, 0.2)", color: scourCount > 0 ? "#f87171" : "#4ade80", fontWeight: 600 }}>
                {scourCount > 0 ? `Scouring (${scourCount} stns)` : "Armored (Stable)"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px", fontSize: 10 }}>
              <div>
                <span style={{ color: "#94a3b8" }}>Shear Stress (τ_b):</span>{" "}
                <strong style={{ color: "#f8fafc" }}>{minTau.toFixed(0)} – {maxTau.toFixed(0)} Pa</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Shields (θ / θ_cr):</span>{" "}
                <strong style={{ color: maxTheta > 0.047 ? "#f97316" : "#4ade80" }}>
                  {maxTheta.toFixed(3)} {maxTheta > 0.047 ? "(Mobilized)" : "(Stable)"}
                </strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Bedload Transport:</span>{" "}
                <strong style={{ color: bedloadFlux > 0.1 ? "#f59e0b" : "#94a3b8" }}>
                  {bedloadFlux.toFixed(1)} kg/s
                </strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Runoff Surge Front:</span>{" "}
                <strong style={{ color: frontProgress < 0.98 && rainIntensity > 0 ? "#38bdf8" : "#94a3b8" }}>
                  {(frontProgress * 100).toFixed(0)}% {frontProgress < 0.98 && rainIntensity > 0 ? "(Surging Bore)" : "(At Confluence)"}
                </strong>
              </div>
            </div>
          </div>

          {/* MOBIDICpy Catchment Hydrology & Soil Budget */}
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dashed rgba(56, 189, 248, 0.25)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
              <span style={{ fontWeight: 600, color: "#38bdf8", fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                🌱 MOBIDIC // Catchment Water Budget
              </span>
              <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 3, background: soilSaturation > 0.75 ? "rgba(56, 189, 248, 0.25)" : "rgba(255, 255, 255, 0.1)", color: soilSaturation > 0.75 ? "#38bdf8" : "#94a3b8", fontWeight: 600 }}>
                {soilSaturation > 0.85 ? "Saturated (Dunne Flow)" : soilSaturation > 0.42 ? "Moist (Percolating)" : "Dry Soil"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px", fontSize: 10 }}>
              <div>
                <span style={{ color: "#94a3b8" }}>Soil Saturation:</span>{" "}
                <strong style={{ color: soilSaturation > 0.70 ? "#38bdf8" : "#f8fafc" }}>
                  {(soilSaturation * 100).toFixed(1)}%
                </strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Infiltration Cap:</span>{" "}
                <strong style={{ color: "#f8fafc" }}>{infilCap.toFixed(1)} mm/h</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Aquifer (V_gw):</span>{" "}
                <strong style={{ color: "#38bdf8" }}>{aquiferStorage.toFixed(0)} m³ (gw)</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Baseflow (Q_gw):</span>{" "}
                <strong style={{ color: "#f8fafc" }}>{qBaseflow.toFixed(1)} m³/s</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Surface Chutes:</span>{" "}
                <strong style={{ color: qSurface > 0.5 ? "#38bdf8" : "#94a3b8" }}>{qSurface.toFixed(1)} m³/s</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Bank Interflow:</span>{" "}
                <strong style={{ color: qInterflow > 0.2 ? "#38bdf8" : "#94a3b8" }}>{qInterflow.toFixed(1)} m³/s</strong>
              </div>
            </div>
          </div>

          {/* Chentanez & Müller 2010 2D Shallow Water Equations (SWE) */}
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dashed rgba(56, 189, 248, 0.25)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
              <span style={{ fontWeight: 600, color: "#38bdf8", fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                🌊 2D SWE // Interactive Waves
              </span>
              <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 3, background: sweWaveEnergy > 0.015 ? "rgba(56, 189, 248, 0.3)" : "rgba(255, 255, 255, 0.1)", color: sweWaveEnergy > 0.015 ? "#38bdf8" : "#94a3b8", fontWeight: 600 }}>
                {sweWaveEnergy > 0.05 ? "Turbulent Waves" : sweWaveEnergy > 0.01 ? "Active Ripples" : "Calm Surface"}
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px", fontSize: 10, marginBottom: 8 }}>
              <div>
                <span style={{ color: "#94a3b8" }}>Wave Grid:</span>{" "}
                <strong style={{ color: "#f8fafc" }}>128 × 256 (32k cells)</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Wave Speed ($c$):</span>{" "}
                <strong style={{ color: "#38bdf8" }}>{sweWaveSpeed.toFixed(1)} m/s (√(gh))</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Wave RMS:</span>{" "}
                <strong style={{ color: "#f8fafc" }}>{(sweWaveEnergy * 100).toFixed(1)} cm</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Peak Crest:</span>{" "}
                <strong style={{ color: sweMaxWave > 0.08 ? "#38bdf8" : "#f8fafc" }}>+{(sweMaxWave * 100).toFixed(1)} cm</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Impulses Fired:</span>{" "}
                <strong style={{ color: "#38bdf8" }}>{sweImpulseCount}</strong>
              </div>
              <div>
                <span style={{ color: "#94a3b8" }}>Boundaries:</span>{" "}
                <strong style={{ color: "#4ade80" }}>Sommerfeld Open</strong>
              </div>
            </div>

            {/* Interactive Tool Mode Switcher */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9.5, color: "#38bdf8", marginBottom: 5, fontWeight: 700, textTransform: "uppercase" }}>
                Interactive Tool Mode:
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
                <button
                  onClick={() => handleInteractionMode("dropper")}
                  style={{
                    padding: "7px 6px",
                    borderRadius: 6,
                    border: interactionMode === "dropper" ? "1.5px solid #38bdf8" : "1px solid rgba(255,255,255,0.12)",
                    background: interactionMode === "dropper" ? "rgba(2, 132, 199, 0.40)" : "rgba(255,255,255,0.06)",
                    boxShadow: interactionMode === "dropper" ? "0 0 12px rgba(56, 189, 248, 0.45)" : "none",
                    color: interactionMode === "dropper" ? "#38bdf8" : "#fff",
                    fontSize: 10,
                    cursor: "pointer",
                    fontWeight: 700,
                    textAlign: "left",
                    display: "flex",
                    flexDirection: "column",
                    gap: 1.5,
                  }}
                >
                  <span>💧 Ripple Dropper</span>
                  <span style={{ fontSize: 8, color: "#94a3b8", fontWeight: 400 }}>Single drops & splashes</span>
                </button>

                <button
                  onClick={() => handleInteractionMode("sweeper")}
                  style={{
                    padding: "7px 6px",
                    borderRadius: 6,
                    border: interactionMode === "sweeper" ? "1.5px solid #34d399" : "1px solid rgba(255,255,255,0.12)",
                    background: interactionMode === "sweeper" ? "rgba(16, 185, 129, 0.35)" : "rgba(255,255,255,0.06)",
                    boxShadow: interactionMode === "sweeper" ? "0 0 12px rgba(52, 211, 153, 0.45)" : "none",
                    color: interactionMode === "sweeper" ? "#34d399" : "#fff",
                    fontSize: 10,
                    cursor: "pointer",
                    fontWeight: 700,
                    textAlign: "left",
                    display: "flex",
                    flexDirection: "column",
                    gap: 1.5,
                  }}
                >
                  <span>🌊 Wave Sweeper</span>
                  <span style={{ fontSize: 8, color: "#94a3b8", fontWeight: 400 }}>Drag continuous wake</span>
                </button>

                <button
                  onClick={() => handleInteractionMode("orbit")}
                  style={{
                    gridColumn: "span 2",
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: interactionMode === "orbit" ? "1.5px solid #fbbf24" : "1px solid rgba(255,255,255,0.12)",
                    background: interactionMode === "orbit" ? "rgba(251, 191, 36, 0.25)" : "rgba(255,255,255,0.06)",
                    boxShadow: interactionMode === "orbit" ? "0 0 10px rgba(251, 191, 36, 0.35)" : "none",
                    color: interactionMode === "orbit" ? "#fcd34d" : "#fff",
                    fontSize: 10,
                    cursor: "pointer",
                    fontWeight: 700,
                    textAlign: "center",
                  }}
                >
                  🎥 Orbit Camera (Free Rotation • Shift-Click to Drop Waves)
                </button>
              </div>

              {/* Dynamic Tool Mode Status Pill */}
              <div
                style={{
                  fontSize: 8.5,
                  padding: "4px 8px",
                  borderRadius: 4,
                  background:
                    interactionMode === "dropper"
                      ? "rgba(56, 189, 248, 0.15)"
                      : interactionMode === "sweeper"
                      ? "rgba(52, 211, 153, 0.15)"
                      : "rgba(251, 191, 36, 0.12)",
                  border:
                    interactionMode === "dropper"
                      ? "1px solid rgba(56, 189, 248, 0.3)"
                      : interactionMode === "sweeper"
                      ? "1px solid rgba(52, 211, 153, 0.3)"
                      : "1px solid rgba(251, 191, 36, 0.25)",
                  color:
                    interactionMode === "dropper"
                      ? "#7dd3fc"
                      : interactionMode === "sweeper"
                      ? "#6ee7b7"
                      : "#fde047",
                  lineHeight: 1.3,
                }}
              >
                {interactionMode === "dropper" && "💧 Cyan 3D Reticle on river: Click anywhere on the water to inject expanding SWE ripples & 3D ballistic splash droplets!"}
                {interactionMode === "sweeper" && "🌊 Emerald 3D Wake Brush: Drag pointer across the river to sweep continuous trailing wake disturbances!"}
                {interactionMode === "orbit" && "🎥 Camera Mode: Drag to rotate view. Shift-click directly on the water to drop waves anytime."}
              </div>
            </div>

            {/* Physical Wave Trigger Buttons */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
              <button
                onClick={handleDropPebble}
                style={{
                  padding: "4px 6px",
                  borderRadius: 5,
                  border: "1px solid rgba(56, 189, 248, 0.3)",
                  background: "rgba(56, 189, 248, 0.12)",
                  color: "#7dd3fc",
                  fontSize: 9.5,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                💧 Drop Pebble
              </button>
              <button
                onClick={handleSurgeWave}
                style={{
                  padding: "4px 6px",
                  borderRadius: 5,
                  border: "1px solid rgba(56, 189, 248, 0.3)",
                  background: "rgba(56, 189, 248, 0.12)",
                  color: "#7dd3fc",
                  fontSize: 9.5,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                🌊 Surge Bore Wave
              </button>
              <button
                onClick={handleBoulderShock}
                style={{
                  padding: "4px 6px",
                  borderRadius: 5,
                  border: "1px solid rgba(56, 189, 248, 0.3)",
                  background: "rgba(56, 189, 248, 0.12)",
                  color: "#7dd3fc",
                  fontSize: 9.5,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                💥 Boulder Shock
              </button>
              <button
                onClick={handleClearWaves}
                style={{
                  padding: "4px 6px",
                  borderRadius: 5,
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  background: "rgba(255, 255, 255, 0.06)",
                  color: "#94a3b8",
                  fontSize: 9.5,
                  cursor: "pointer",
                }}
              >
                🔄 Calm River
              </button>
            </div>
            <div style={{ fontSize: 8.5, color: "#64748b", marginTop: 4, fontStyle: "italic" }}>
              *Click or drag anywhere on the river to create physical 2D SWE wave rings & 3D ballistic splashes.
            </div>
          </div>
        </div>

        {/* Precipitation & Hillslope Runoff Controls */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#38bdf8", textTransform: "uppercase", marginBottom: 6 }}>
            Precipitation & Hillslope Runoff
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
            <button
              onClick={() => handleRainIntensity(0.0)}
              style={{
                padding: "6px 4px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: rainIntensity === 0.0 ? "#0284c7" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 10,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              ☀️ Dry (0)
            </button>
            <button
              onClick={() => handleRainIntensity(25.0)}
              style={{
                padding: "6px 4px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: rainIntensity === 25.0 ? "#0284c7" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 10,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              🌧️ Rain (25)
            </button>
            <button
              onClick={() => handleRainIntensity(65.0)}
              style={{
                padding: "6px 4px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: rainIntensity === 65.0 ? "#0284c7" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 10,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              ⛈️ Storm (65)
            </button>
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 12 }}>
              <span style={{ color: "#d6d3d1" }}>Rain Rate</span>
              <span style={{ color: rainIntensity > 0 ? "#38bdf8" : "#94a3b8", fontWeight: 600 }}>
                {rainIntensity.toFixed(0)} mm/h
              </span>
            </div>
            <input
              type="range"
              min={0.0}
              max={80.0}
              step={1.0}
              value={rainIntensity}
              onChange={(e) => handleRainIntensity(parseFloat(e.target.value))}
              style={{ width: "100%", accentColor: "#38bdf8", cursor: "pointer" }}
            />
          </div>
        </div>

        {/* Discharge Flow Regime Presets */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#38bdf8", textTransform: "uppercase", marginBottom: 6 }}>
            Flow Regime Presets
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            <button
              onClick={() => handleDischarge(12.0)}
              style={{
                padding: "6px 4px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: dischargeQ === 12.0 ? "#0284c7" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 10,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              🍃 Low (12 m³/s)
            </button>
            <button
              onClick={() => handleDischarge(22.0)}
              style={{
                padding: "6px 4px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: dischargeQ === 22.0 ? "#0284c7" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 10,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              🌊 Normal (22 m³/s)
            </button>
            <button
              onClick={() => handleDischarge(45.0)}
              style={{
                padding: "6px 4px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: dischargeQ === 45.0 ? "#0284c7" : "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 10,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              ⚡ Torrent (45 m³/s)
            </button>
          </div>
        </div>

        {/* Sliders */}
        <div style={{ display: "flex", flexDirection: "column", gap: 11, marginBottom: 14 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 12 }}>
              <span style={{ color: "#d6d3d1" }}>Volumetric Discharge ($Q$)</span>
              <span style={{ color: "#38bdf8", fontWeight: 600 }}>{dischargeQ.toFixed(1)} m³/s</span>
            </div>
            <input
              type="range"
              min={8.0}
              max={55.0}
              step={0.5}
              value={dischargeQ}
              onChange={(e) => handleDischarge(parseFloat(e.target.value))}
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

        {/* Camera Views */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#38bdf8", textTransform: "uppercase", marginBottom: 6 }}>
            Camera Viewpoints
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <button
              onClick={() => handlePreset("macro")}
              style={{
                gridColumn: "span 2",
                padding: "8px 8px",
                borderRadius: 6,
                border: !followRiver && activePreset === "macro" ? "1.5px solid #38bdf8" : "1px solid rgba(56, 189, 248, 0.4)",
                background: !followRiver && activePreset === "macro" ? "rgba(2, 132, 199, 0.55)" : "rgba(56, 189, 248, 0.15)",
                color: !followRiver && activePreset === "macro" ? "#38bdf8" : "#7dd3fc",
                fontSize: 11,
                cursor: "pointer",
                fontWeight: 700,
                boxShadow: !followRiver && activePreset === "macro" ? "0 0 14px rgba(56, 189, 248, 0.45)" : "none",
              }}
            >
              💎 Stream-Grade Macro (1.8m Boulder & Pebble Close-Up)
            </button>
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
            <button
              onClick={() => handlePreset("runoff")}
              style={{
                gridColumn: "span 2",
                padding: "7px 8px",
                borderRadius: 6,
                border: "1px solid rgba(56, 189, 248, 0.4)",
                background: !followRiver && activePreset === "runoff" ? "#0284c7" : "rgba(56, 189, 248, 0.12)",
                color: !followRiver && activePreset === "runoff" ? "#fff" : "#7dd3fc",
                fontSize: 11,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              🏞️ Hillslope Runoff & Pools View
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

        {/* Toggles */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={sprayEnabled}
              onChange={(e) => handleSprayToggle(e.target.checked)}
              style={{ accentColor: "#38bdf8" }}
            />
            <span>3D Physical Spray Particles (Kinetic boulder impacts)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={foamDriftEnabled}
              onChange={(e) => handleFoamDriftToggle(e.target.checked)}
              style={{ accentColor: "#38bdf8" }}
            />
            <span>Aerated Rapid Foam & Turbulent Froth (Hydrodynamic)</span>
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
              handleDischarge(22.0);
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
          <div>Solver: <strong style={{ color: "#d6d3d1" }}>Saint-Venant 1D</strong></div>
          <div>Roughness ($n$): <strong style={{ color: "#d6d3d1" }}>0.040 (Manning)</strong></div>
          <div>Continuity: <strong style={{ color: "#d6d3d1" }}>Q = A · v = const</strong></div>
          <div>Energy: <strong style={{ color: "#d6d3d1" }}>E = h + v²/2g</strong></div>
          <div>Water Shading: <strong style={{ color: "#d6d3d1" }}>Beer-Lambert + SSR</strong></div>
          <div>Spray System: <strong style={{ color: "#d6d3d1" }}>Kinetic SPH Droplets</strong></div>
          <div>2D Waves: <strong style={{ color: "#d6d3d1" }}>Chentanez & Müller SWE</strong></div>
          <div>SWE Boundary: <strong style={{ color: "#d6d3d1" }}>Sommerfeld Radiation</strong></div>
        </div>
      </div>
    </div>
  );
}
