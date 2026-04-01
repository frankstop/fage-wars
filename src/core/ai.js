import { DIFFICULTIES, FACTIONS, OWNER_NEUTRAL } from "./config.js";

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export class AISystem {
  constructor(simulation, difficultyId) {
    this.simulation = simulation;
    this.setDifficulty(difficultyId);
    this.resetControllers();
  }

  setDifficulty(difficultyId) {
    this.profile = DIFFICULTIES[difficultyId] ?? DIFFICULTIES.normal;
  }

  resetControllers() {
    this.controllers = this.simulation
      .getActiveFactionIds()
      .filter((ownerId) => !FACTIONS[ownerId]?.isHuman)
      .map((ownerId) => ({
        ownerId,
        cooldown: randomRange(this.profile.reactionMin, this.profile.reactionMax),
      }));
  }

  update(dt) {
    if (this.simulation.status !== "playing") {
      return;
    }

    for (const controller of this.controllers) {
      if (this.simulation.getCellsByOwner(controller.ownerId).length === 0) {
        continue;
      }

      controller.cooldown -= dt * this.simulation.speed;
      if (controller.cooldown > 0) {
        continue;
      }

      const plan = this.choosePlan(controller.ownerId);
      if (plan) {
        this.executePlan(controller.ownerId, plan);
        controller.cooldown =
          this.profile.cooldownBase +
          plan.sources.length * this.profile.cooldownPerSource +
          (plan.type === "defend" ? 0.18 : plan.type === "stage" ? 0.26 : 0.34) +
          randomRange(0.04, 0.18);
      } else {
        controller.cooldown = randomRange(this.profile.idleMin, this.profile.idleMax);
      }
    }
  }

  choosePlan(ownerId) {
    const state = this.getStrategicState(ownerId);
    const defense = this.findDefensePlan(ownerId);
    if (defense) {
      return defense;
    }

    const expansion = this.findBestExpansionPlan(ownerId);
    const attack = this.findBestAttackPlan(ownerId);
    const canAttack = this.canPressure(state, attack);
    const canStageAttack = this.canStagePressure(state, attack);

    if (state.neutralCount > 0 && expansion) {
      if (!attack) {
        return expansion.plan;
      }

      if (!canAttack) {
        return expansion.plan;
      }

      const expansionScore = expansion.score * this.profile.expansionWeight;
      const attackScore = attack.score * this.profile.attackWeight;
      if (expansionScore >= attackScore) {
        return expansion.plan;
      }
      if (attack.readyPlan) {
        return attack.readyPlan;
      }
      if (attack.stagePlan) {
        return attack.stagePlan;
      }
      return expansion.plan;
    }

    if (canAttack && attack?.readyPlan) {
      return attack.readyPlan;
    }

    if (expansion) {
      return expansion.plan;
    }

    if (canStageAttack && attack?.stagePlan) {
      return attack.stagePlan;
    }

    return null;
  }

  getStrategicState(ownerId) {
    const ownCells = this.simulation.getCellsByOwner(ownerId);
    const enemyStats = this.simulation
      .getFactionStats()
      .filter((entry) => entry.ownerId !== ownerId);
    const ownPopulation = ownCells.reduce((sum, cell) => sum + cell.population, 0);
    const strongestEnemyPopulation = Math.max(
      1,
      ...enemyStats.map((entry) => entry.population),
    );

    return {
      ownPopulation,
      neutralCount: this.simulation.getCellsByOwner(OWNER_NEUTRAL).length,
      territoryShare: ownCells.length / Math.max(1, this.simulation.cells.length),
      populationLeadRatio: ownPopulation / strongestEnemyPopulation,
    };
  }

  canPressure(state, attack) {
    if (!attack) {
      return false;
    }
    if (state.neutralCount === 0) {
      return true;
    }
    if (this.isFreeHit(attack)) {
      return true;
    }
    return (
      state.territoryShare >= this.profile.attackProgressGate &&
      state.populationLeadRatio >= this.profile.attackLeadGate
    );
  }

  canStagePressure(state, attack) {
    if (!attack?.stagePlan) {
      return false;
    }
    if (state.neutralCount === 0) {
      return true;
    }
    return (
      state.territoryShare >= this.profile.stageProgressGate ||
      state.populationLeadRatio >= this.profile.attackLeadGate + 0.08
    );
  }

  isFreeHit(attack) {
    return (
      Boolean(attack.readyPlan) &&
      attack.supportCount <= this.profile.freeTargetSupport &&
      attack.captureCostRatio <= this.profile.freeTargetCost
    );
  }

  findDefensePlan(ownerId) {
    const endangered = this.simulation
      .getCellsByOwner(ownerId)
      .map((cell) => {
        const projection = this.simulation.projectCellBalance(
          cell.id,
          ownerId,
          this.profile.threatHorizon,
        );
        const danger = projection.hostile - projection.friendly;
        const nearbyEnemies = this.countNearbyCells(cell, this.profile.frontierRadius, (other) => {
          return other.owner !== ownerId && other.owner !== OWNER_NEUTRAL;
        });
        return {
          cell,
          projection,
          score: danger + nearbyEnemies * 5 + cell.capacity * 0.12,
        };
      })
      .filter(
        (entry) =>
          entry.projection.hostile > 0 &&
          entry.projection.balance < Math.ceil(entry.cell.capacity * this.profile.defenseMargin),
      )
      .sort((a, b) => b.score - a.score);

    for (const entry of endangered) {
      const required =
        Math.ceil(entry.cell.capacity * this.profile.defenseMargin) - entry.projection.balance;
      const plan = this.buildFriendlyPlan(ownerId, entry.cell, required);
      if (plan) {
        return {
          ...plan,
          type: "defend",
        };
      }
    }

    return null;
  }

  findBestExpansionPlan(ownerId) {
    const plans = this.simulation.cells
      .filter((cell) => cell.owner === OWNER_NEUTRAL)
      .map((target) => {
        const capture = this.buildCapturePlan(ownerId, target, this.profile.expansionMargin);
        if (!capture.readyPlan) {
          return null;
        }

        const score =
          target.capacity * 0.62 * this.profile.productionWeight +
          target.growth * 12 * this.profile.productionWeight +
          this.getHubValue(target) * 4 -
          target.population * 1.05 -
          average(capture.readyPlan.sources.map((source) => source.distance)) * 0.03 -
          this.countNearbyCells(target, 230, (other) => other.owner !== ownerId && other.owner !== OWNER_NEUTRAL) * 5;

        return {
          score,
          plan: {
            ...capture.readyPlan,
            type: "expand",
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return plans[0] ?? null;
  }

  findBestAttackPlan(ownerId) {
    const plans = this.simulation.cells
      .filter((cell) => cell.owner !== ownerId && cell.owner !== OWNER_NEUTRAL)
      .map((target) => {
        const capture = this.buildCapturePlan(ownerId, target, this.profile.attackMargin);
        const supportCount = this.countNearbyCells(
          target,
          this.profile.frontierRadius,
          (other) => other.owner === target.owner && other.id !== target.id,
        );
        const score =
          target.capacity * 0.76 * this.profile.productionWeight +
          target.growth * 15 * this.profile.productionWeight +
          this.getHubValue(target) * 5 +
          Math.max(0, 3 - supportCount) * 8 -
          capture.required * 0.52 -
          average(capture.sources.map((source) => source.distance)) * 0.03 -
          supportCount * this.profile.supportPenalty;

        return {
          score,
          supportCount,
          captureCostRatio:
            target.capacity === 0 ? capture.required : capture.required / target.capacity,
          readyPlan: capture.readyPlan
            ? {
                ...capture.readyPlan,
                type: "attack",
              }
            : null,
          stagePlan: this.buildStagePlan(ownerId, target, capture),
        };
      })
      .sort((a, b) => b.score - a.score);

    return plans[0] ?? null;
  }

  buildFriendlyPlan(ownerId, target, required) {
    const donors = this.getDonorCandidates(ownerId, target, {
      excludeIds: [target.id],
      prioritizeDistance: true,
    });

    const sources = [];
    let total = 0;
    for (const donor of donors) {
      sources.push(donor);
      total += donor.sendable;
      if (total >= required || sources.length >= this.profile.coordination) {
        break;
      }
    }

    if (total < required || sources.length === 0) {
      return null;
    }

    return {
      targetId: target.id,
      sources,
      required,
    };
  }

  buildCapturePlan(ownerId, target, margin) {
    const sources = [];
    const candidates = this.getDonorCandidates(ownerId, target, {
      excludeIds: [],
      prioritizeDistance: true,
    });

    let total = 0;
    let arrivalWindow = 0;
    let required = Math.ceil(target.population * margin + 1);

    for (const candidate of candidates) {
      sources.push(candidate);
      total += candidate.sendable;
      arrivalWindow = Math.max(arrivalWindow, candidate.travelTime);
      required = Math.ceil(
        this.simulation.estimateTargetStrength(target, ownerId, arrivalWindow) * margin + 1,
      );

      if (total >= required) {
        return {
          required,
          total,
          sources,
          readyPlan: {
            targetId: target.id,
            sources,
          },
        };
      }

      if (sources.length >= this.profile.coordination) {
        break;
      }
    }

    return {
      required,
      total,
      sources,
      readyPlan: null,
    };
  }

  buildStagePlan(ownerId, target, capture) {
    if (!this.profile.stageEnabled || capture.sources.length === 0) {
      return null;
    }

    const missing = capture.required - capture.total;
    if (missing <= 0) {
      return null;
    }

    const missingRatio = capture.required === 0 ? 0 : missing / capture.required;
    if (missingRatio < this.profile.stageThreshold) {
      return null;
    }

    const stageCell = this.simulation
      .getCellsByOwner(ownerId)
      .filter((cell) => distance(cell, target) <= this.profile.frontierRadius)
      .sort((a, b) => {
        const aScore = distance(a, target) - a.population * 0.25 - a.capacity * 0.12;
        const bScore = distance(b, target) - b.population * 0.25 - b.capacity * 0.12;
        return aScore - bScore;
      })[0];

    if (!stageCell) {
      return null;
    }

    const required = Math.max(
      this.profile.minSendable,
      Math.min(
        Math.ceil(missing + 2),
        Math.max(0, stageCell.capacity - stageCell.population),
      ),
    );

    if (required <= 0) {
      return null;
    }

    const donors = this.getDonorCandidates(ownerId, stageCell, {
      excludeIds: [stageCell.id],
      prioritizeDistance: true,
    });

    const sources = [];
    let total = 0;
    for (const donor of donors) {
      sources.push(donor);
      total += donor.sendable;
      if (total >= required || sources.length >= this.profile.coordination) {
        break;
      }
    }

    if (sources.length === 0 || total < required) {
      return null;
    }

    return {
      type: "stage",
      targetId: stageCell.id,
      sources,
    };
  }

  getDonorCandidates(ownerId, target, options) {
    return this.simulation
      .getCellsByOwner(ownerId)
      .filter((cell) => !options.excludeIds.includes(cell.id))
      .map((cell) => {
        const sendable = this.simulation.getSendableCount(cell);
        const safety = this.simulation.estimateSourceSafety(cell, sendable, ownerId);
        const reserveFloor = Math.max(4, Math.ceil(cell.capacity * this.profile.reserveFactor));
        return {
          cell,
          sendable,
          safety,
          distance: distance(cell, target),
          travelTime: this.simulation.getTravelTime(cell, target),
          reserveFloor,
        };
      })
      .filter(
        (entry) =>
          entry.sendable >= this.profile.minSendable &&
          entry.safety >= entry.reserveFloor,
      )
      .sort((a, b) => {
        if (options.prioritizeDistance) {
          return a.distance - b.distance || b.sendable - a.sendable;
        }
        return b.sendable - a.sendable || a.distance - b.distance;
      });
  }

  countNearbyCells(origin, radius, predicate) {
    return this.simulation.cells.filter((cell) => {
      if (cell.id === origin.id) {
        return false;
      }
      return distance(cell, origin) <= radius && predicate(cell);
    }).length;
  }

  getHubValue(cell) {
    return this.countNearbyCells(cell, 260, () => true);
  }

  executePlan(ownerId, plan) {
    for (const sourcePlan of plan.sources) {
      this.simulation.issueOrder(ownerId, sourcePlan.cell.id, plan.targetId);
    }
  }
}
