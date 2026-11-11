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

## Directive 02: Catchment Hydrology & In-Stream Morphodynamics (Permanent)
> **"Water movement across the landscape and riverbed must obey the coupled laws of watershed hydrology (MOBIDICpy) and river morphodynamics (REEF3D)."**

### Core Requirements
1. **MOBIDICpy Catchment Mass Balance:**
   - Rainfall must dynamically partition into infiltration ($I$) and surface runoff ($R$) via dual-pore soil saturation ($S_{\text{soil}} \in [0, 1]$).
   - Infiltration capacity must decay nonlinearly as soil saturates ($f_c(S) = K_{\text{sat}} + (f_0 - K_{\text{sat}})(1 - S_{\text{soil}})^2$).
   - River baseflow must be generated physically from a deep groundwater aquifer reservoir ($Q_{\text{base}} = k_{\text{gw}} \cdot V_{\text{gw}}$), creating real hydrological recession limbs.
   - Total river discharge must follow tripartite flow separation:
     $$Q_{\text{total}}(t) = Q_{\text{surface}}(t) + Q_{\text{interflow}}(t) + Q_{\text{baseflow}}(t)$$

2. **REEF3D River Morphodynamics:**
   - In-stream sediment mobilization must be governed by the local Shields parameter:
     $$\theta = \frac{\tau_b}{(\rho_s - \rho) g d_{50}} = \frac{\rho g R_h S}{1052.0}$$
   - Riverbed gravel and pebbles must mobilize into active rolling and saltation whenever $\theta > \theta_{\text{cr}} = 0.047$, and deposit into gravel bars in low-shear pools ($\theta < \theta_{\text{cr}}$).
   - High-velocity flow colliding with boulders must generate non-hydrostatic stagnation bow roosters ($+0.42 \frac{v^2}{2g}$) and downstream wake drawdown cavities.


