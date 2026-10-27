"use client";

import { useEffect, useRef, useState } from "react";
import { Game } from "@/game/engine";

export default function GameCanvas() {
  const mountRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const mount = async () => {
      if (!mountRef.current || cancelled) return;
      try {
        const game = new Game(mountRef.current, (msg) => setError(msg));
        gameRef.current = game;
        await game.start();
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to start the engine");
        }
      }
    };
    void mount();
    return () => {
      cancelled = true;
      gameRef.current?.dispose();
      gameRef.current = null;
    };
  }, []);

  return (
    <div className="game-root">
      <div ref={mountRef} className="game-mount" />
      {error ? (
        <div className="game-error">
          <div className="game-error-title">ENGINE FAULT</div>
          <div className="game-error-msg">{error}</div>
          <div className="game-error-sub">
            This engine needs WebGL — try a desktop browser with hardware acceleration.
          </div>
        </div>
      ) : null}
    </div>
  );
}
