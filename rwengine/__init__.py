"""
rwengine: an approximate rain & weather simulation engine.

Full water cycle on a 2-D catchment:
  atmospheric moisture transport -> condensation -> Marshall-Palmer rain ->
  Green-Ampt infiltration / Manning-D8 runoff -> layered soil moisture ->
  geotechnical response (suction, cohesion, bearing capacity, mud) ->
  evaporation back to the boundary layer.

Usage:
    from rwengine.engine import WeatherEngine
    engine = WeatherEngine("thunderstorm")
    engine.run()
"""
from .config import EngineConfig, PRESETS, SOIL_TEXTURES
from .engine import WeatherEngine

__all__ = ["WeatherEngine", "EngineConfig", "PRESETS", "SOIL_TEXTURES"]
__version__ = "1.0.0"
