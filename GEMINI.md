# AI Directives & Simulation Laws

## Directive 01: Water Physics & Ground Impact (Permanent)
> **"The rainfall may be an atmospheric visual effect, but the moment rainfall hits the ground, it turns into true 3D water with physical water properties."**

### Core Requirements
1. **True 3D Geometry:**
   - Water on the ground (runoff, rills, puddles, river) must **never** be a flat, paper-thin 2D ribbon or simple transparent plane.
   - Runoff channels must feature true 3D cross-sectional depth, parabolic surface curvature (meniscus camber), vertical boundary walls, and carved erosion troughs in the bedrock.
   - Water surfaces must physically displace vertices in 3D space under turbulence and supercritical flow ($Fr > 1.0$).

2. **Hydrodynamic Water Properties:**
   - Flow velocities must be governed by physical equations (Manning-Strickler equation $v = \frac{1}{n} R_h^{2/3} \sqrt{S}$).
   - Stream paths must follow the physical steepest descent terrain vector field ($-\nabla z_{\text{bed}}$).
   - Channel cross-sections and flow rates must obey mass continuity ($Q = A \cdot v$).
   - Depressions and puddles must track volumetric storage and mass balance ($\Delta h = (P - I)\Delta t$).

3. **Kinetic 3D Splashes & Confluence Hydrodynamics:**
   - When water flows down cliffs and hits barriers or plunges into the river, it must dynamically eject physical 3D splash and spray droplets with ballistic gravity and forward velocity.
   - Falling rain impacting the ground must trigger physical surface crown ripples and splatter.
