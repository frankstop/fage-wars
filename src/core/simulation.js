import {
  CELL_TYPES,
  FACTIONS,
  GAME_RULES,
  OWNER_NEUTRAL,
} from "./config.js";

let swarmIdCounter = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class Simulation {
  constructor(map, difficulty) {
    this.loadMap(map, difficulty);
  }

  loadMap(map, difficulty) {
    this.map = map;
    this.difficulty = difficulty;
    this.time = 0;
    this.status = "playing";
    this.speed = GAME_RULES.speedOptions[0];
    this.events = [];
    this.commandCount = 0;
    this.lastCapture = null;

    this.cells = map.cells.map((cell) => {
      const type = CELL_TYPES[cell.size];
      return {
        ...cell,
        radius: type.radius,
        growth: type.growth,
        capacity: type.capacity,
        population: Math.round(cell.population),
        growthProgress: 0,
        overflowProgress: 0,
        pulseOffset: Math.random() * Math.PI * 2,
      };
    });

    this.swarms = [];
    this.factionIds = [...new Set(this.cells.map((cell) => cell.owner))].filter(
      (ownerId) => ownerId !== OWNER_NEUTRAL,
    );
  }

  setSpeed(nextSpeed) {
    if (GAME_RULES.speedOptions.includes(nextSpeed)) {
      this.speed = nextSpeed;
    }
  }

  getCell(cellId) {
    return this.cells.find((cell) => cell.id === cellId) ?? null;
  }

  getTravelTime(source, target) {
    if (!source || !target) {
      return 0;
    }
    const distance = Math.hypot(target.x - source.x, target.y - source.y);
    const travelFactor = target.owner === OWNER_NEUTRAL ? GAME_RULES.neutralTravelFactor : 1;
    return clamp((distance / 248) * travelFactor, 0.28, 4.1);
  }

  getCellsByOwner(ownerId) {
    return this.cells.filter((cell) => cell.owner === ownerId);
  }

  getActiveFactionIds() {
    const active = new Set();
    for (const cell of this.cells) {
      if (cell.owner !== OWNER_NEUTRAL) {
        active.add(cell.owner);
      }
    }
    return [...active];
  }

  getSendableCount(cell) {
    if (!cell || cell.owner === OWNER_NEUTRAL) {
      return 0;
    }
    const byFraction = Math.floor(cell.population * GAME_RULES.sendFraction);
    const byReserve = Math.floor(cell.population - GAME_RULES.minGarrison);
    return Math.max(0, Math.min(byFraction, byReserve));
  }

  getIncomingTotals(cellId, horizonSeconds = Infinity) {
    const totals = new Map();
    for (const swarm of this.swarms) {
      if (swarm.targetId !== cellId) {
        continue;
      }
      const remaining = swarm.travelTime - swarm.elapsed;
      if (remaining > horizonSeconds) {
        continue;
      }
      totals.set(swarm.owner, (totals.get(swarm.owner) ?? 0) + swarm.count);
    }
    return totals;
  }

  projectCellBalance(cellId, ownerId, horizonSeconds = Infinity) {
    const cell = this.getCell(cellId);
    if (!cell) {
      return { friendly: 0, hostile: 0, balance: 0 };
    }
    const totals = this.getIncomingTotals(cellId, horizonSeconds);
    let friendly = 0;
    let hostile = 0;
    for (const [incomingOwner, count] of totals.entries()) {
      if (incomingOwner === ownerId) {
        friendly += count;
      } else {
        hostile += count;
      }
    }
    return {
      friendly,
      hostile,
      balance:
        cell.population +
        this.estimateGrowthUnits(cell, horizonSeconds) +
        friendly -
        hostile,
    };
  }

  estimateGrowthUnits(cell, seconds) {
    if (!cell || cell.owner === OWNER_NEUTRAL || !Number.isFinite(seconds)) {
      return 0;
    }
    if (cell.population >= cell.capacity) {
      return 0;
    }
    return Math.min(
      cell.capacity - cell.population,
      Math.floor(cell.growthProgress + cell.growth * seconds),
    );
  }

  estimateTargetStrength(target, attackerOwner, arrivalWindow) {
    let projected = target.population;
    if (target.owner !== OWNER_NEUTRAL) {
      projected += this.estimateGrowthUnits(target, arrivalWindow);
    }

    for (const swarm of this.swarms) {
      if (swarm.targetId !== target.id) {
        continue;
      }
      const remaining = swarm.travelTime - swarm.elapsed;
      if (remaining > arrivalWindow) {
        continue;
      }
      if (swarm.owner === target.owner) {
        projected += swarm.count;
      } else if (swarm.owner === attackerOwner) {
        projected -= swarm.count;
      } else {
        projected -= swarm.count * 0.65;
      }
    }
    return Math.max(0, projected);
  }

  estimateSourceSafety(source, sendCount, ownerId) {
    const projected = this.projectCellBalance(source.id, ownerId);
    return projected.balance - sendCount;
  }

  canIssueOrder(ownerId, sourceId, targetId) {
    if (this.status !== "playing") {
      return false;
    }
    const source = this.getCell(sourceId);
    const target = this.getCell(targetId);
    if (!source || !target || source.id === target.id) {
      return false;
    }
    if (source.owner !== ownerId) {
      return false;
    }
    return this.getSendableCount(source) > 0;
  }

  issueOrder(ownerId, sourceId, targetId) {
    if (!this.canIssueOrder(ownerId, sourceId, targetId)) {
      return null;
    }

    const source = this.getCell(sourceId);
    const target = this.getCell(targetId);
    const count = this.getSendableCount(source);
    if (count < 1) {
      return null;
    }

    source.population -= count;

    const travelTime = this.getTravelTime(source, target);

    const swarm = {
      id: `swarm-${++swarmIdCounter}`,
      owner: ownerId,
      count,
      sourceId,
      targetId,
      fromX: source.x,
      fromY: source.y,
      toX: target.x,
      toY: target.y,
      elapsed: 0,
      travelTime,
    };

    this.swarms.push(swarm);
    this.commandCount += 1;
    this.events.push({
      type: "dispatch",
      owner: ownerId,
      sourceId,
      targetId,
      count,
    });
    return swarm;
  }

  update(rawDt) {
    if (this.status !== "playing") {
      this.events = [];
      return;
    }

    this.events = [];
    const dt = clamp(rawDt, 0, 0.05) * this.speed;
    this.time += dt;

    this.growCells(dt);
    this.decayOverflow(dt);
    this.advanceSwarms(dt);
    this.checkVictory();
  }

  growCells(dt) {
    for (const cell of this.cells) {
      if (cell.owner === OWNER_NEUTRAL) {
        continue;
      }
      if (cell.population >= cell.capacity) {
        cell.growthProgress = 0;
        continue;
      }

      cell.growthProgress += cell.growth * dt;
      const gain = Math.floor(cell.growthProgress);
      if (gain > 0) {
        const applied = Math.min(gain, cell.capacity - cell.population);
        cell.population += applied;
        cell.growthProgress -= applied;
      }
    }
  }

  decayOverflow(dt) {
    for (const cell of this.cells) {
      const hardCap = Math.floor(cell.capacity * GAME_RULES.overflowMultiplier);
      if (cell.population > hardCap) {
        cell.population = hardCap;
      }
      if (cell.population > cell.capacity) {
        const overflow = cell.population - cell.capacity;
        cell.overflowProgress += overflow * GAME_RULES.overflowDecay * dt;
        const loss = Math.floor(cell.overflowProgress);
        if (loss > 0) {
          const applied = Math.min(loss, overflow);
          cell.population = Math.max(cell.capacity, cell.population - applied);
          cell.overflowProgress -= applied;
        }
      } else {
        cell.overflowProgress = 0;
      }
    }
  }

  advanceSwarms(dt) {
    const nextSwarms = [];
    for (const swarm of this.swarms) {
      swarm.elapsed += dt;
      if (swarm.elapsed >= swarm.travelTime) {
        this.resolveSwarm(swarm);
      } else {
        nextSwarms.push(swarm);
      }
    }
    this.swarms = nextSwarms;
  }

  resolveSwarm(swarm) {
    const target = this.getCell(swarm.targetId);
    if (!target) {
      return;
    }

    if (target.owner === swarm.owner) {
      target.population = Math.min(
        target.population + swarm.count,
        Math.floor(target.capacity * GAME_RULES.overflowMultiplier),
      );
      this.events.push({
        type: "reinforce",
        owner: swarm.owner,
        x: target.x,
        y: target.y,
        count: swarm.count,
      });
      return;
    }

    target.population -= swarm.count;
    if (target.population <= 0) {
      const previousOwner = target.owner;
      const survivors = Math.abs(target.population);
      target.owner = swarm.owner;
      target.population = Math.min(
        Math.max(1, survivors),
        Math.floor(target.capacity * GAME_RULES.overflowMultiplier),
      );
      target.growthProgress = 0;
      target.overflowProgress = 0;
      this.lastCapture = {
        targetId: target.id,
        owner: swarm.owner,
        previousOwner,
      };
      this.events.push({
        type: "capture",
        owner: swarm.owner,
        previousOwner,
        x: target.x,
        y: target.y,
        label: target.id,
      });
      return;
    }

    this.events.push({
      type: "impact",
      owner: swarm.owner,
      defender: target.owner,
      x: target.x,
      y: target.y,
    });
  }

  checkVictory() {
    const active = this.getActiveFactionIds();
    if (!active.includes("player")) {
      this.status = "defeat";
      return;
    }

    if (active.length === 1 && active[0] === "player") {
      this.status = "victory";
    }
  }

  getFactionStats() {
    const stats = {};
    for (const [factionId, faction] of Object.entries(FACTIONS)) {
      if (factionId === OWNER_NEUTRAL) {
        continue;
      }
      stats[factionId] = {
        ownerId: factionId,
        label: faction.label,
        color: faction.color,
        cells: 0,
        population: 0,
      };
    }

    for (const cell of this.cells) {
      if (cell.owner === OWNER_NEUTRAL) {
        continue;
      }
      if (!stats[cell.owner]) {
        continue;
      }
      stats[cell.owner].cells += 1;
      stats[cell.owner].population += cell.population;
    }
    return Object.values(stats).filter((entry) => entry.cells > 0);
  }

  getPlayerProgress() {
    const playerCells = this.cells.filter((cell) => cell.owner === "player").length;
    const totalCells = this.cells.length;
    return totalCells === 0 ? 0 : playerCells / totalCells;
  }
}
