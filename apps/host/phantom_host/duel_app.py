"""Isolated device-lab bootstrap; no legacy workers or gameplay authority yet."""

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict


class SpellRule(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    spell: Literal["stupefy", "protego", "expelliarmus"]
    enabled: bool
    damage: int
    cooldownMs: int
    flightMs: int = 0
    shieldMs: int = 0
    offenseLockMs: int = 0


class Ruleset(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    version: Literal[1] = 1
    roundMs: int = 60_000
    maxHp: int = 100
    offensiveRecoveryMs: int = 600
    spells: tuple[SpellRule, ...]


RULES = Ruleset(spells=(
    SpellRule(spell="stupefy", enabled=True, damage=20, cooldownMs=2000, flightMs=2000),
    SpellRule(spell="protego", enabled=True, damage=0, cooldownMs=3000, shieldMs=1200),
    SpellRule(spell="expelliarmus", enabled=False, damage=10, cooldownMs=6000,
              flightMs=2200, offenseLockMs=1000),
))


class Health(BaseModel):
    version: Literal[1] = 1
    stage: Literal["device-lab"] = "device-lab"
    multiplayerReady: Literal[False] = False


def create_app() -> FastAPI:
    app = FastAPI(title="Wand Duel — Device Lab", docs_url=None, redoc_url=None)

    @app.get("/api/game/health", response_model=Health)
    async def health() -> Health:
        return Health()

    @app.get("/api/game/rules", response_model=Ruleset)
    async def rules() -> Ruleset:
        return RULES

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
