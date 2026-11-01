#!/bin/bash
# Mud material QA: physics assertions + visual shots (glisten, churn, crust, boots)
set -u
cd "$(dirname "$0")"
SHOT=../../scripts/qa_mud
B="agent-browser"

$B open http://localhost:3000
$B wait --load networkidle
$B wait 2500
$B set viewport 1600 900
# start the ride (click the canvas / boot overlay)
$B eval "window.__game ? 'HAS GAME' : 'NO GAME'"
$B eval "$(cat 01_physics.js)"
$B wait --fn "window.__qaMudLog !== undefined" --timeout 60000
$B eval "JSON.stringify(window.__qaMudLog, null, 1)"

# ---- visual 1: storm mud close-up (glisten + churned prints) ----
$B eval "window.__game.loadPreset('thunderstorm', true).then(()=>{ window.__game.fastForward(45); const c = window.__qaMud; const g = window.__game; g.player.pos.x = c.x; g.player.pos.z = c.z + 1; g.player.pos.y += 2; g.micro.centerOn(c.x, c.z); g.input.yaw = 3.14; g.player.addPitch(0.35); g.player.addZoom(-2.6); window.__shot1 = true; }); 'teleporting'"
$B wait --fn "window.__shot1 === true" --timeout 60000
$B wait 3000
$B screenshot 01_storm_mud.png

# ---- visual 2: soil inspector over the mud ----
$B eval "window.__game.renderInspector(); 'inspector'"
$B wait 800
$B screenshot 02_inspector.png

# ---- visual 3: drying crust (clear sky, ~12 h) ----
$B eval "window.__game.loadPreset('clear_sky', true).then(()=>{ window.__game.fastForward(700); const c = window.__qaCrustCell || {x: 0, z: 0}; const g = window.__game; g.player.pos.x = c.x; g.player.pos.z = c.z + 1; g.player.pos.y += 2; g.micro.centerOn(c.x, c.z); g.player.addPitch(0.5); window.__shot3 = true; }); 'drying'"
$B wait --fn "window.__shot3 === true" --timeout 60000
$B wait 2500
$B screenshot 03_dry_cracked.png

# ---- visual 4: muddy boots (walk in mud, camera low on the legs) ----
$B eval "window.__game.loadPreset('monsoon', true).then(()=>{ window.__game.fastForward(80); const c = window.__qaMud; const g = window.__game; g.player.pos.x = c.x; g.player.pos.z = c.z; g.player.pos.y += 2; g.micro.centerOn(c.x, c.z); g.input.forward = 1; g.input.yaw = 0.9; for (let i = 0; i < 240; i++) g.player.update(1/30, g.input, 0); g.input.forward = 0; g.player.addZoom(-3.0); g.player.addPitch(0.5); window.__shot4 = g.player.bootMud; }); 'boots'"
$B wait --fn "window.__shot4 !== undefined" --timeout 60000
$B wait 2000
$B screenshot 04_muddy_boots.png

$B eval "window.__shot4"
$B errors
echo "=== QA SHOTS DONE ==="
