import { AISystem } from "./core/ai.js";
import {
  DIFFICULTIES,
  FACTIONS,
  GAME_RULES,
  OWNER_NEUTRAL,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  factionName,
} from "./core/config.js";
import { Simulation } from "./core/simulation.js";
import { CAMPAIGN_MAPS } from "./data/maps.js";

const SAVE_KEY = "fage-wars-save-v1";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${secs}`;
}

function loadSave() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) {
    return {
      unlocked: 1,
      difficulty: "normal",
      completed: {},
    };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      unlocked: clamp(parsed.unlocked ?? 1, 1, CAMPAIGN_MAPS.length),
      difficulty: parsed.difficulty ?? "normal",
      completed: parsed.completed ?? {},
    };
  } catch {
    return {
      unlocked: 1,
      difficulty: "normal",
      completed: {},
    };
  }
}

function saveProgress(saveData) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(saveData));
}

class FageWarsApp {
  constructor() {
    this.canvas = document.querySelector("#game-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.mapChip = document.querySelector("#map-chip");
    this.statusPanel = document.querySelector("#status-panel");
    this.selectionPanel = document.querySelector("#selection-panel");
    this.controlPanel = document.querySelector("#control-panel");
    this.factionPanel = document.querySelector("#faction-panel");
    this.menuOverlay = document.querySelector("#menu-overlay");
    this.infoOverlay = document.querySelector("#info-overlay");
    this.infoTitle = document.querySelector("#info-title");
    this.infoMission = document.querySelector("#info-mission");
    this.infoControls = document.querySelector("#info-controls");
    this.infoRules = document.querySelector("#info-rules");
    this.infoFactions = document.querySelector("#info-factions");
    this.infoCloseButton = document.querySelector("#info-close-button");
    this.campaignGrid = document.querySelector("#campaign-grid");
    this.difficultySelect = document.querySelector("#difficulty-select");
    this.saveNote = document.querySelector("#save-note");
    this.toastNode = document.querySelector("#toast");
    this.resetProgressButton = document.querySelector("#reset-progress-button");
    this.resultOverlay = document.querySelector("#result-overlay");
    this.resultKicker = document.querySelector("#result-kicker");
    this.resultTitle = document.querySelector("#result-title");
    this.resultBody = document.querySelector("#result-body");
    this.resultPrimary = document.querySelector("#result-primary");
    this.resultSecondary = document.querySelector("#result-secondary");

    this.saveData = loadSave();

    this.simulation = null;
    this.ai = null;
    this.currentMapIndex = null;
    this.selectedCellId = null;
    this.dragSourceId = null;
    this.dragSourceIds = [];
    this.dragSourceLookup = new Set();
    this.hoverTargetId = null;
    this.pointer = {
      isDown: false,
      pointerType: "mouse",
      x: 0,
      y: 0,
      downCellId: null,
    };
    this.paused = false;
    this.infoOpen = false;
    this.pendingResult = null;
    this.effects = [];
    this.links = [];
    this.toastTimeout = 0;
    this.lastTimestamp = performance.now();
    this.uiAccumulator = 1;

    this.renderDifficultyPills();
    this.renderCampaignGrid();
    this.renderControlPanel();
    this.updateSaveNote();
    this.updatePanels(true);
    this.bindEvents();

    requestAnimationFrame((timestamp) => this.frame(timestamp));
  }

  bindEvents() {
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointercancel", () => this.cancelPointer());
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    this.difficultySelect.addEventListener("click", (event) => {
      const button = event.target.closest("[data-difficulty]");
      if (!button) {
        return;
      }
      this.saveData.difficulty = button.dataset.difficulty;
      saveProgress(this.saveData);
      this.renderDifficultyPills();
      this.renderCampaignGrid();
      this.updateSaveNote();
    });

    this.campaignGrid.addEventListener("click", (event) => {
      const card = event.target.closest("[data-map-index]");
      if (!card) {
        return;
      }
      const index = Number(card.dataset.mapIndex);
      if (index + 1 > this.saveData.unlocked) {
        return;
      }
      this.startLevel(index);
    });

    this.controlPanel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-control]");
      if (!button) {
        return;
      }
      const control = button.dataset.control;
      if (control === "pause") {
        this.paused = !this.paused;
      } else if (control === "restart") {
        this.restartLevel();
      } else if (control === "menu") {
        this.openMenu();
      } else if (control === "info") {
        this.openInfo();
      } else if (control.startsWith("speed-")) {
        const speed = Number(control.replace("speed-", ""));
        if (this.simulation) {
          this.simulation.setSpeed(speed);
          this.toast(`Board speed set to ${speed.toFixed(1)}x`);
        }
      }
      this.renderControlPanel();
      this.updatePanels(true);
    });

    this.selectionPanel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-control]");
      if (!button) {
        return;
      }
      if (button.dataset.control === "info") {
        if (this.infoOpen) {
          this.closeInfo();
        } else {
          this.openInfo();
        }
      }
    });

    this.resetProgressButton.addEventListener("click", () => {
      const confirmed = window.confirm("Reset campaign progress and best times?");
      if (!confirmed) {
        return;
      }
      this.saveData = {
        unlocked: 1,
        difficulty: "normal",
        completed: {},
      };
      saveProgress(this.saveData);
      this.renderDifficultyPills();
      this.renderCampaignGrid();
      this.updateSaveNote();
      this.toast("Campaign progress reset");
    });

    this.resultPrimary.addEventListener("click", () => {
      if (!this.pendingResult) {
        return;
      }
      if (this.pendingResult.type === "victory" && this.currentMapIndex < CAMPAIGN_MAPS.length - 1) {
        this.startLevel(this.currentMapIndex + 1);
        return;
      }
      this.restartLevel();
    });

    this.resultSecondary.addEventListener("click", () => {
      this.openMenu();
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (this.infoVisible()) {
          this.closeInfo();
        } else if (this.menuVisible()) {
          this.closeMenu();
        } else {
          this.openMenu();
        }
      } else if (event.key.toLowerCase() === "i") {
        if (this.simulation && !this.menuVisible() && !this.resultVisible()) {
          if (this.infoVisible()) {
            this.closeInfo();
          } else {
            this.openInfo();
          }
        }
      } else if (event.key.toLowerCase() === "r") {
        this.restartLevel();
      } else if (event.key === " ") {
        if (this.simulation) {
          event.preventDefault();
          this.paused = !this.paused;
          this.renderControlPanel();
        }
      } else if (["1", "2", "3"].includes(event.key) && this.simulation) {
        const speed = GAME_RULES.speedOptions[Number(event.key) - 1];
        this.simulation.setSpeed(speed);
        this.renderControlPanel();
      }
    });
  }

  menuVisible() {
    return !this.menuOverlay.classList.contains("overlay--hidden");
  }

  resultVisible() {
    return !this.resultOverlay.classList.contains("overlay--hidden");
  }

  infoVisible() {
    return this.infoOpen;
  }

  openMenu() {
    this.menuOverlay.classList.remove("overlay--hidden");
    this.closeInfo();
    this.renderCampaignGrid();
    this.updateSaveNote();
    this.renderControlPanel();
  }

  closeMenu() {
    if (this.currentMapIndex === null) {
      return;
    }
    this.menuOverlay.classList.add("overlay--hidden");
  }

  hideResult() {
    this.resultOverlay.classList.add("overlay--hidden");
    this.pendingResult = null;
  }

  openInfo() {
    this.infoOpen = true;
    this.updatePanels(true);
    this.renderControlPanel();
  }

  closeInfo() {
    this.infoOpen = false;
    this.updatePanels(true);
    this.renderControlPanel();
  }

  showResult(type) {
    const map = CAMPAIGN_MAPS[this.currentMapIndex];
    const completion = this.saveData.completed[map.id];
    if (type === "victory") {
      const nextExists = this.currentMapIndex < CAMPAIGN_MAPS.length - 1;
      this.resultKicker.textContent = this.currentMapIndex === CAMPAIGN_MAPS.length - 1 ? "Campaign Complete" : "Map Cleared";
      this.resultTitle.textContent =
        this.currentMapIndex === CAMPAIGN_MAPS.length - 1
          ? "FAGE WARS completed"
          : `${map.name} cleared`;
      this.resultBody.textContent = `Time ${formatTime(this.simulation.time)}. Best time ${
        completion ? formatTime(completion.bestTime) : formatTime(this.simulation.time)
      }.`;
      this.resultPrimary.textContent = nextExists ? "Next Map" : "Replay Map";
      this.resultSecondary.textContent = "Campaign";
    } else {
      this.resultKicker.textContent = "Try Again";
      this.resultTitle.textContent = `${map.name} lost`;
      this.resultBody.textContent =
        "Your board control slipped away. Restart the encounter or return to the campaign map.";
      this.resultPrimary.textContent = "Retry Map";
      this.resultSecondary.textContent = "Campaign";
    }
    this.pendingResult = { type };
    this.resultOverlay.classList.remove("overlay--hidden");
  }

  startLevel(index) {
    this.currentMapIndex = index;
    this.selectedCellId = null;
    this.dragSourceId = null;
    this.dragSourceIds = [];
    this.dragSourceLookup = new Set();
    this.hoverTargetId = null;
    this.paused = false;
    this.hideResult();
    this.closeInfo();
    this.menuOverlay.classList.add("overlay--hidden");

    const map = CAMPAIGN_MAPS[index];
    this.simulation = new Simulation(map, DIFFICULTIES[this.saveData.difficulty]);
    this.ai = new AISystem(this.simulation, this.saveData.difficulty);
    this.effects = [];
    this.links = this.buildLinks(this.simulation.cells);
    this.renderControlPanel();
    this.updatePanels(true);
    this.toast(`Map ${map.index}: ${map.name}`);
  }

  restartLevel() {
    if (this.currentMapIndex === null) {
      return;
    }
    this.startLevel(this.currentMapIndex);
  }

  buildLinks(cells) {
    const links = [];
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        const a = cells[i];
        const b = cells[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist < 340) {
          links.push([a, b, dist]);
        }
      }
    }
    return links;
  }

  getWorldPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * WORLD_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * WORLD_HEIGHT,
    };
  }

  pickCell(point) {
    if (!this.simulation) {
      return null;
    }
    const sorted = [...this.simulation.cells].sort((a, b) => b.radius - a.radius);
    return (
      sorted.find((cell) => Math.hypot(point.x - cell.x, point.y - cell.y) <= cell.radius) ??
      null
    );
  }

  onPointerDown(event) {
    if (!this.simulation || this.menuVisible() || this.resultVisible()) {
      return;
    }
    this.canvas.setPointerCapture(event.pointerId);
    const point = this.getWorldPoint(event);
    const cell = this.pickCell(point);
    this.pointer.isDown = true;
    this.pointer.pointerType = event.pointerType;
    this.pointer.x = point.x;
    this.pointer.y = point.y;
    this.pointer.downCellId = cell?.id ?? null;

    if (cell && cell.owner === "player") {
      this.selectedCellId = cell.id;
      this.dragSourceId = cell.id;
      this.dragSourceIds = [cell.id];
      this.dragSourceLookup = new Set([cell.id]);
    } else if (event.pointerType !== "mouse" && this.selectedCellId) {
      this.dragSourceId = this.selectedCellId;
      this.dragSourceIds = [this.selectedCellId];
      this.dragSourceLookup = new Set([this.selectedCellId]);
    } else if (!cell) {
      this.hoverTargetId = null;
      this.dragSourceIds = [];
      this.dragSourceLookup = new Set();
    }
    this.updatePanels(true);
  }

  onPointerMove(event) {
    if (!this.simulation) {
      return;
    }
    const point = this.getWorldPoint(event);
    this.pointer.x = point.x;
    this.pointer.y = point.y;
    if (this.pointer.isDown && this.dragSourceIds.length > 0) {
      const hovered = this.pickCell(point);
      let shouldRefreshPanels = false;
      if (!hovered) {
        if (this.hoverTargetId !== null) {
          this.hoverTargetId = null;
          shouldRefreshPanels = true;
        }
        if (shouldRefreshPanels) {
          this.updatePanels(true);
        }
        return;
      }

      if (hovered.owner === "player") {
        if (!this.dragSourceLookup.has(hovered.id)) {
          this.dragSourceIds.push(hovered.id);
          this.dragSourceLookup.add(hovered.id);
          shouldRefreshPanels = true;
        }
        if (this.hoverTargetId !== null) {
          this.hoverTargetId = null;
          shouldRefreshPanels = true;
        }
      } else {
        if (this.hoverTargetId !== hovered.id) {
          this.hoverTargetId = hovered.id;
          shouldRefreshPanels = true;
        }
      }

      if (shouldRefreshPanels) {
        this.updatePanels(true);
      }
    }
  }

  onPointerUp(event) {
    if (!this.simulation || this.menuVisible() || this.resultVisible()) {
      this.cancelPointer();
      return;
    }

    const point = this.getWorldPoint(event);
    const releasedCell = this.pickCell(point);
    const pointerType = this.pointer.pointerType;
    const sourceIds = this.dragSourceIds.length > 0 ? [...this.dragSourceIds] : [];

    if (pointerType === "mouse") {
      if (
        sourceIds.length > 0 &&
        releasedCell &&
        !this.dragSourceLookup.has(releasedCell.id)
      ) {
        this.tryPlayerOrders(sourceIds, releasedCell.id);
      } else if (releasedCell?.owner === "player") {
        this.selectedCellId = releasedCell.id;
      } else if (!releasedCell) {
        this.selectedCellId = null;
      }
    } else {
      if (
        sourceIds.length > 0 &&
        releasedCell &&
        !this.dragSourceLookup.has(releasedCell.id)
      ) {
        this.tryPlayerOrders(sourceIds, releasedCell.id);
      } else if (releasedCell?.owner === "player") {
        this.selectedCellId = releasedCell.id;
        this.toast("Source cell armed. Tap a target.");
      } else if (!releasedCell) {
        this.selectedCellId = null;
      }
    }

    this.cancelPointer();
    this.updatePanels(true);
  }

  cancelPointer() {
    this.pointer.isDown = false;
    this.pointer.downCellId = null;
    this.dragSourceId = null;
    this.dragSourceIds = [];
    this.dragSourceLookup = new Set();
    this.hoverTargetId = null;
  }

  tryPlayerOrder(sourceId, targetId) {
    return this.tryPlayerOrders([sourceId], targetId);
  }

  getLaunchPreview(sourceIds, targetId = null) {
    if (!this.simulation || sourceIds.length === 0) {
      return null;
    }

    const sources = [...new Set(sourceIds)]
      .map((sourceId) => this.simulation.getCell(sourceId))
      .filter((cell) => cell && cell.owner === "player");

    if (sources.length === 0) {
      return null;
    }

    const totalUnits = sources.reduce(
      (sum, source) => sum + this.simulation.getSendableCount(source),
      0,
    );

    if (!targetId) {
      return {
        sourceCount: sources.length,
        totalUnits,
        travelTime: 0,
        target: null,
      };
    }

    const target = this.simulation.getCell(targetId);
    if (!target) {
      return {
        sourceCount: sources.length,
        totalUnits,
        travelTime: 0,
        target: null,
      };
    }

    const travelTime = Math.max(
      ...sources.map((source) => this.simulation.getTravelTime(source, target)),
    );
    const projectedDefenders = Math.ceil(
      this.simulation.estimateTargetStrength(target, "player", travelTime),
    );
    const margin = totalUnits - projectedDefenders;

    return {
      sourceCount: sources.length,
      totalUnits,
      travelTime,
      target,
      projectedDefenders,
      capture: target.owner === "player" ? true : margin >= 0,
      survivors: target.owner === "player" ? totalUnits : Math.max(1, margin),
      deficit: target.owner === "player" ? 0 : Math.max(0, -margin),
    };
  }

  tryPlayerOrders(sourceIds, targetId) {
    if (!this.simulation) {
      return 0;
    }

    let issued = 0;
    let totalUnits = 0;
    const uniqueSourceIds = [...new Set(sourceIds)];

    for (const sourceId of uniqueSourceIds) {
      const swarm = this.simulation.issueOrder("player", sourceId, targetId);
      if (!swarm) {
        continue;
      }

      issued += 1;
      totalUnits += swarm.count;
      this.effects.push({
        type: "dispatch",
        x: swarm.fromX,
        y: swarm.fromY,
        radius: 18,
        life: 0.34,
        maxLife: 0.34,
        color: FACTIONS.player.color,
      });
    }

    if (issued === 0) {
      const firstSource = this.simulation.getCell(uniqueSourceIds[0]);
      if (firstSource && this.simulation.getSendableCount(firstSource) <= 0) {
        this.toast("Selected colonies are too depleted to launch.");
      }
      return 0;
    }

    const anchorSource = this.simulation.getCell(uniqueSourceIds[0]);
    if (anchorSource && anchorSource.owner === "player") {
      this.selectedCellId = anchorSource.id;
    }

    if (issued > 1) {
      this.toast(`${issued} colonies launched ${totalUnits} units.`);
    }

    return issued;
  }

  frame(timestamp) {
    const rawDt = Math.min((timestamp - this.lastTimestamp) / 1000, 0.05);
    this.lastTimestamp = timestamp;

    const active =
      this.simulation &&
      !this.menuVisible() &&
      !this.resultVisible() &&
      !this.paused;

    if (active) {
      this.simulation.update(rawDt);
      this.ai.update(rawDt);
      this.consumeEvents(this.simulation.events);

      if (this.simulation.status === "victory") {
        this.recordVictory();
        this.showResult("victory");
      } else if (this.simulation.status === "defeat") {
        this.showResult("defeat");
      }
    }

    this.updateEffects(rawDt);
    this.render();

    this.uiAccumulator += rawDt;
    if (this.uiAccumulator >= 0.08) {
      this.updatePanels();
      this.uiAccumulator = 0;
    }

    if (this.toastTimeout > 0) {
      this.toastTimeout -= rawDt;
      if (this.toastTimeout <= 0) {
        this.toastNode.classList.remove("is-visible");
      }
    }

    requestAnimationFrame((nextTimestamp) => this.frame(nextTimestamp));
  }

  recordVictory() {
    const map = CAMPAIGN_MAPS[this.currentMapIndex];
    if (!map || this.pendingResult?.type === "victory") {
      return;
    }

    const existing = this.saveData.completed[map.id];
    if (!existing || this.simulation.time < existing.bestTime) {
      this.saveData.completed[map.id] = {
        bestTime: this.simulation.time,
      };
    }
    this.saveData.unlocked = Math.min(
      CAMPAIGN_MAPS.length,
      Math.max(this.saveData.unlocked, this.currentMapIndex + 2),
    );
    saveProgress(this.saveData);
    this.renderCampaignGrid();
    this.updateSaveNote();
  }

  consumeEvents(events) {
    for (const event of events) {
      if (event.type === "capture") {
        this.effects.push({
          type: "capture",
          x: event.x,
          y: event.y,
          radius: 24,
          life: 0.8,
          maxLife: 0.8,
          color: FACTIONS[event.owner]?.color ?? "#ffffff",
        });

        if (event.owner === "player") {
          this.toast(`Capture secured from ${factionName(event.previousOwner)}.`);
        } else if (event.previousOwner === "player") {
          this.toast(`A player colony fell to ${factionName(event.owner)}.`);
        }
      } else if (event.type === "impact") {
        this.effects.push({
          type: "impact",
          x: event.x,
          y: event.y,
          radius: 12,
          life: 0.22,
          maxLife: 0.22,
          color: FACTIONS[event.owner]?.color ?? "#ffffff",
        });
      } else if (event.type === "reinforce") {
        this.effects.push({
          type: "impact",
          x: event.x,
          y: event.y,
          radius: 10,
          life: 0.18,
          maxLife: 0.18,
          color: FACTIONS[event.owner]?.color ?? "#ffffff",
        });
      }
    }
  }

  updateEffects(dt) {
    this.effects = this.effects
      .map((effect) => ({
        ...effect,
        life: effect.life - dt,
      }))
      .filter((effect) => effect.life > 0);
  }

  toast(message) {
    this.toastNode.textContent = message;
    this.toastNode.classList.add("is-visible");
    this.toastTimeout = 2.2;
  }

  renderDifficultyPills() {
    this.difficultySelect.innerHTML = Object.values(DIFFICULTIES)
      .map(
        (difficulty) => `
          <button
            type="button"
            class="difficulty-pill ${difficulty.id === this.saveData.difficulty ? "is-active" : ""}"
            data-difficulty="${difficulty.id}"
          >
            ${difficulty.label}
          </button>
        `,
      )
      .join("");
  }

  renderCampaignGrid() {
    this.campaignGrid.innerHTML = CAMPAIGN_MAPS.map((map, index) => {
      const unlocked = index + 1 <= this.saveData.unlocked;
      const complete = this.saveData.completed[map.id];
      return `
        <button
          type="button"
          class="level-card ${unlocked ? "" : "is-locked"} ${complete ? "is-complete" : ""}"
          data-map-index="${index}"
        >
          <p class="eyebrow">Map ${map.index.toString().padStart(2, "0")}</p>
          <h3>${map.name}</h3>
          <p class="subtitle">${map.briefing}</p>
          <div class="level-meta">
            <span>${map.cells.length} cells</span>
            <span>${complete ? `Best ${formatTime(complete.bestTime)}` : unlocked ? `Par ${formatTime(map.parTime)}` : "Locked"}</span>
          </div>
        </button>
      `;
    }).join("");
  }

  renderControlPanel() {
    const speed = this.simulation?.speed ?? 1;
    this.controlPanel.innerHTML = `
      <p class="label">Controls</p>
      <div class="toolbar">
        <div class="toolbar-group">
          <button type="button" data-control="info">${this.infoOpen ? "Hide Brief" : "Briefing"}</button>
          <button type="button" data-control="pause">${this.paused ? "Resume" : "Pause"}</button>
        </div>
        <div class="toolbar-group">
          <button type="button" data-control="restart">Restart</button>
          <button type="button" data-control="menu">Campaign</button>
        </div>
        <div class="toolbar-group">
        ${GAME_RULES.speedOptions
          .map(
            (option) => `
              <button type="button" data-control="speed-${option}" ${
                speed === option ? 'style="border-color: rgba(122, 99, 72, 0.34); background: linear-gradient(180deg, rgba(221, 244, 206, 0.96), rgba(249, 233, 201, 0.98));"' : ""
              }>${option.toFixed(1)}x</button>
            `,
          )
          .join("")}
        </div>
      </div>
    `;
  }

  updateSaveNote() {
    const completed = Object.keys(this.saveData.completed).length;
    this.saveNote.textContent = `${completed} / ${CAMPAIGN_MAPS.length} maps cleared. Difficulty: ${
      DIFFICULTIES[this.saveData.difficulty].label
    }.`;
  }

  updateInfoPanel() {
    if (!this.infoMission) {
      return;
    }

    if (!this.simulation) {
      this.infoTitle.textContent = "How To Play";
      this.infoMission.textContent = "Pick any unlocked map from the campaign board to begin.";
      this.infoControls.innerHTML = `
        <p>Mouse: hold on a colony, sweep across any friendly colonies you want in the group, then release on a target.</p>
        <p>Touch: tap a colony, then tap the destination.</p>
        <p>Use the Info button during play whenever you want the mission text back.</p>
      `;
      this.infoRules.innerHTML = `
        <p>Owned cells grow automatically over time.</p>
        <p>Each order launches one single 50% burst.</p>
        <p>Captured cells immediately join your production network.</p>
      `;
      this.infoFactions.innerHTML = "";
      return;
    }

    const map = CAMPAIGN_MAPS[this.currentMapIndex];
    const factionStats = this.simulation
      .getFactionStats()
      .sort((a, b) => b.cells - a.cells || b.population - a.population);

    this.infoTitle.textContent = `${map.name} Briefing`;
    this.infoMission.textContent = map.briefing;
    this.infoControls.innerHTML = `
      <p>Mouse: hold on a player colony, sweep across more friendly colonies, then release on a target.</p>
      <p>Touch: tap a player colony, then tap the destination.</p>
      <p>Shortcuts: <strong>I</strong> opens this window, <strong>R</strong> restarts, <strong>Space</strong> pauses.</p>
    `;
    this.infoRules.innerHTML = `
      <p>Every order is a one-shot launch of 50% of the source population.</p>
      <p>Population left behind stays home as defense while owned colonies keep growing.</p>
      <p>If your arrivals beat the defenders, the cell flips and surviving units become the new garrison.</p>
    `;
    this.infoFactions.innerHTML = factionStats
      .map(
        (entry) => `
          <div class="faction-row">
            <span class="faction-swatch" style="color:${entry.color}; background:${entry.color};"></span>
            <span>${entry.label}</span>
            <span>${entry.cells} / ${entry.population}</span>
          </div>
        `,
      )
      .join("");
  }

  getInfoPanelMarkup(map, factionStats) {
    const controls = this.simulation
      ? `
        <div class="info-copy">
          <p>Mouse: hold on a player colony, sweep across more friendly colonies, then release on a target.</p>
          <p>Touch: tap a player colony, then tap the destination.</p>
          <p><strong>I</strong> toggles this panel. <strong>Space</strong> pauses. <strong>R</strong> restarts.</p>
        </div>
      `
      : `
        <div class="info-copy">
          <p>Mouse: hold on a colony, sweep across any friendly colonies you want in the group, then release on a target.</p>
          <p>Touch: tap a colony, then tap the destination.</p>
          <p>Use the Info button any time you want the briefing visible.</p>
        </div>
      `;

    const rules = `
      <div class="info-copy">
        <p>Owned cells grow automatically over time.</p>
        <p>Every order launches one single 50% burst.</p>
        <p>If your arrivals beat the defenders, the cell flips and surviving units become the new garrison.</p>
      </div>
    `;

    const factionsMarkup =
      factionStats.length > 0
        ? `
          <div class="faction-list faction-list--compact">
            ${factionStats
              .map(
                (entry) => `
                  <div class="faction-row">
                    <span class="faction-swatch" style="color:${entry.color}; background:${entry.color};"></span>
                    <span>${entry.label}</span>
                    <span>${entry.cells}</span>
                  </div>
                `,
              )
              .join("")}
          </div>
        `
        : "";

    return `
      <div class="panel-header">
        <p class="label">Briefing</p>
        <button type="button" class="button button--ghost panel-close" data-control="info">Hide</button>
      </div>
      <p class="value">${map ? map.name : "How To Play"}</p>
      <div class="info-copy">
        <p>${map ? map.briefing : "Pick any unlocked map from the campaign board to begin."}</p>
      </div>
      <div class="info-divider"></div>
      <p class="label">Controls</p>
      ${controls}
      <div class="info-divider"></div>
      <p class="label">Rules</p>
      ${rules}
      ${factionsMarkup ? `<div class="info-divider"></div><p class="label">Board Pressure</p>${factionsMarkup}` : ""}
    `;
  }

  setPanelVisibility(panel, visible) {
    panel.classList.toggle("panel--hidden", !visible);
  }

  updatePanels(force = false) {
    if (!this.simulation && !force) {
      return;
    }

    if (!this.simulation) {
      this.mapChip.textContent = "Campaign Interface";
      this.statusPanel.innerHTML = `
        <p class="label">Campaign</p>
        <div class="metric-strip">
          <div class="metric-inline">
            <div class="label">Maps</div>
            <div class="value">${Object.keys(this.saveData.completed).length} / ${CAMPAIGN_MAPS.length}</div>
          </div>
          <div class="metric-inline">
            <div class="label">Mode</div>
            <div class="value">${DIFFICULTIES[this.saveData.difficulty].label}</div>
          </div>
        </div>
      `;
      this.selectionPanel.innerHTML = this.infoOpen
        ? this.getInfoPanelMarkup(null, [])
        : "";
      this.factionPanel.innerHTML = "";
      this.setPanelVisibility(this.statusPanel, true);
      this.setPanelVisibility(this.selectionPanel, this.infoOpen);
      this.selectionPanel.classList.toggle("panel--scroll", this.infoOpen);
      this.setPanelVisibility(this.factionPanel, false);
      this.updateInfoPanel();
      return;
    }

    const map = CAMPAIGN_MAPS[this.currentMapIndex];
    const playerCells = this.simulation.getCellsByOwner("player");
    const selected = this.selectedCellId ? this.simulation.getCell(this.selectedCellId) : null;
    const factionStats = this.simulation
      .getFactionStats()
      .sort((a, b) => b.cells - a.cells || b.population - a.population);

    this.mapChip.textContent = `Map ${map.index.toString().padStart(2, "0")}  •  ${map.name}  •  ${
      DIFFICULTIES[this.saveData.difficulty].label
    }`;

    this.statusPanel.innerHTML = `
      <p class="label">Board</p>
      <div class="metric-strip">
        <div class="metric-inline">
          <div class="label">Time</div>
          <div class="value">${formatTime(this.simulation.time)}</div>
        </div>
        <div class="metric-inline">
          <div class="label">Cells</div>
          <div class="value">${playerCells.length} / ${this.simulation.cells.length}</div>
        </div>
        <div class="metric-inline">
          <div class="label">Swarms</div>
          <div class="value">${this.simulation.swarms.length}</div>
        </div>
        <div class="metric-inline">
          <div class="label">Orders</div>
          <div class="value">${this.simulation.commandCount}</div>
        </div>
      </div>
    `;

    if (this.infoOpen) {
      this.selectionPanel.innerHTML = this.getInfoPanelMarkup(map, factionStats);
      this.setPanelVisibility(this.selectionPanel, true);
      this.selectionPanel.classList.add("panel--scroll");
    } else if (this.pointer.isDown && this.dragSourceIds.length > 0) {
      const preview = this.getLaunchPreview(this.dragSourceIds, this.hoverTargetId);
      if (preview) {
        const outcomeLabel = !preview.target
          ? "Ready"
          : preview.target.owner === "player"
            ? "Stack"
            : preview.capture
              ? "Capture"
              : "Need";
        const outcomeValue = !preview.target
          ? "Aim"
          : preview.target.owner === "player"
            ? `+${preview.totalUnits}`
            : preview.capture
              ? `${preview.survivors}`
              : `${preview.deficit}`;
        const outcomeTone =
          !preview.target || preview.target.owner === "player"
            ? ""
            : preview.capture
              ? "is-success"
              : "is-danger";
        const helper = !preview.target
          ? "Sweep across friendly colonies, then release on the target."
          : preview.target.owner === "player"
            ? `Reinforcement lands in about ${preview.travelTime.toFixed(1)}s.`
            : preview.capture
              ? `Projected against ${preview.projectedDefenders} defenders at arrival.`
              : `Projected target strength is ${preview.projectedDefenders}.`;

        this.selectionPanel.innerHTML = `
          <p class="label">Launch</p>
          <p class="value">${
            preview.sourceCount === 1
              ? "1 colony armed"
              : `${preview.sourceCount} colonies armed`
          }</p>
          <div class="metric-strip">
            <div class="metric-inline">
              <div class="label">Cells</div>
              <div class="value">${preview.sourceCount}</div>
            </div>
            <div class="metric-inline">
              <div class="label">Shot</div>
              <div class="value">${preview.totalUnits}</div>
            </div>
            <div class="metric-inline">
              <div class="label">Travel</div>
              <div class="value">${preview.target ? preview.travelTime.toFixed(1) : "0.0"}s</div>
            </div>
            <div class="metric-inline">
              <div class="label">${outcomeLabel}</div>
              <div class="value ${outcomeTone}">${outcomeValue}</div>
            </div>
          </div>
          <div class="selection-actions">${helper}</div>
        `;
        this.setPanelVisibility(this.selectionPanel, true);
        this.selectionPanel.classList.remove("panel--scroll");
      }
    } else if (selected && selected.owner === "player") {
      const sendable = this.simulation.getSendableCount(selected);
      this.selectionPanel.innerHTML = `
        <p class="label">Selected</p>
        <p class="value">${selected.size.toUpperCase()} colony</p>
        <div class="metric-strip">
          <div class="metric-inline">
            <div class="label">Pop</div>
            <div class="value">${selected.population}</div>
          </div>
          <div class="metric-inline">
            <div class="label">Growth</div>
            <div class="value">${selected.growth.toFixed(2)}</div>
          </div>
          <div class="metric-inline">
            <div class="label">Cap</div>
            <div class="value">${selected.capacity}</div>
          </div>
          <div class="metric-inline">
            <div class="label">Shot</div>
            <div class="value">${sendable}</div>
          </div>
        </div>
      `;
      this.setPanelVisibility(this.selectionPanel, true);
      this.selectionPanel.classList.remove("panel--scroll");
    } else {
      this.selectionPanel.innerHTML = "";
      this.setPanelVisibility(this.selectionPanel, false);
      this.selectionPanel.classList.remove("panel--scroll");
    }

    this.factionPanel.innerHTML = `
      <p class="label">Pressure</p>
      <div class="faction-list faction-list--compact">
        ${factionStats
          .map(
            (entry) => `
              <div class="faction-row">
                <span class="faction-swatch" style="color:${entry.color}; background:${entry.color};"></span>
                <span>${entry.label}</span>
                <span>${entry.cells}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    `;
    this.setPanelVisibility(this.statusPanel, true);
    this.setPanelVisibility(this.factionPanel, true);
    this.updateInfoPanel();
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.drawBackground(ctx);

    if (!this.simulation) {
      this.drawTitleState(ctx);
      return;
    }

    this.drawLinks(ctx);
    this.drawSwarms(ctx);
    this.drawCells(ctx);
    this.drawEffects(ctx);
    this.drawSelection(ctx);

    if (this.paused && !this.menuVisible() && !this.resultVisible()) {
      ctx.save();
      ctx.fillStyle = "rgba(255, 248, 234, 0.48)";
      ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      ctx.fillStyle = "#4b382c";
      ctx.font = '700 44px "Marker Felt", "Trebuchet MS", sans-serif';
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
      ctx.restore();
    }
  }

  drawBackground(ctx) {
    const sky = ctx.createLinearGradient(0, 0, 0, WORLD_HEIGHT * 0.62);
    sky.addColorStop(0, "#cbeefe");
    sky.addColorStop(0.55, "#f0fbff");
    sky.addColorStop(1, "#fff7e8");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    for (let i = 0; i < 6; i += 1) {
      const drift = (this.simulation?.time ?? 0) * (4 + i * 0.7);
      this.drawCloud(
        ctx,
        140 + ((i * 248 + drift) % (WORLD_WIDTH + 220)) - 110,
        116 + ((i * 67) % 140),
        0.8 + i * 0.09,
      );
    }

    this.drawHill(ctx, 520, 64, "#bfe6a1", 0.18);
    this.drawHill(ctx, 602, 92, "#98d07b", 0.35);
    this.drawHill(ctx, 692, 88, "#79bf67", 0.52);

    const meadow = ctx.createLinearGradient(0, 560, 0, WORLD_HEIGHT);
    meadow.addColorStop(0, "rgba(170, 220, 129, 0)");
    meadow.addColorStop(0.22, "rgba(170, 220, 129, 0.12)");
    meadow.addColorStop(1, "rgba(119, 186, 92, 0.22)");
    ctx.fillStyle = meadow;
    ctx.fillRect(0, 560, WORLD_WIDTH, WORLD_HEIGHT - 560);

    for (let i = 0; i < 54; i += 1) {
      const x = 30 + ((i * 173) % (WORLD_WIDTH - 60));
      const y = 592 + ((i * 91) % 220);
      const size = 1 + (i % 3);
      this.drawFlowerDot(ctx, x, y, size, i % 4 === 0 ? "#ffffff" : i % 4 === 1 ? "#ffd67a" : i % 4 === 2 ? "#ffb2a5" : "#b8a4eb");
    }
  }

  drawTitleState(ctx) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#443429";
    ctx.font = '700 58px "Marker Felt", "Trebuchet MS", sans-serif';
    ctx.fillText("FAGE WARS", WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 18);
    ctx.fillStyle = "rgba(68, 52, 41, 0.72)";
    ctx.font = '400 24px "Trebuchet MS", "Gill Sans", sans-serif';
    ctx.fillText("Open an unlocked map from the campaign overlay.", WORLD_WIDTH / 2, WORLD_HEIGHT / 2 + 26);
    ctx.restore();
  }

  drawCloud(ctx, x, y, scale) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
    ctx.beginPath();
    ctx.arc(x, y, 28 * scale, Math.PI * 0.5, Math.PI * 1.5);
    ctx.arc(x + 26 * scale, y - 14 * scale, 24 * scale, Math.PI, Math.PI * 2);
    ctx.arc(x + 54 * scale, y, 28 * scale, Math.PI * 1.5, Math.PI * 0.5);
    ctx.arc(x + 28 * scale, y + 12 * scale, 28 * scale, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawHill(ctx, baseY, amplitude, color, phase) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, WORLD_HEIGHT);
    ctx.lineTo(0, baseY);
    for (let x = 0; x <= WORLD_WIDTH; x += 60) {
      const y = baseY + Math.sin(x * 0.008 + phase * 6) * amplitude;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(WORLD_WIDTH, WORLD_HEIGHT);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawFlowerDot(ctx, x, y, size, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, size + 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff9ef";
    ctx.beginPath();
    ctx.arc(x, y, size * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawLinks(ctx) {
    ctx.save();
    for (const [a, b, dist] of this.links) {
      const alpha = clamp(0.18 - dist / 2400, 0.05, 0.12);
      ctx.strokeStyle = `rgba(153, 125, 91, ${alpha})`;
      ctx.lineWidth = 8;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      ctx.strokeStyle = `rgba(255, 246, 227, ${alpha + 0.08})`;
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCells(ctx) {
    const cells = [...this.simulation.cells].sort((a, b) => a.radius - b.radius);
    for (const cell of cells) {
      const faction = FACTIONS[cell.owner] ?? FACTIONS.neutral;
      const pulse = 0.96 + Math.sin(this.simulation.time * 1.6 + cell.pulseOffset) * 0.03;
      const ringRadius = cell.radius + 18;
      const glow = ctx.createRadialGradient(
        cell.x,
        cell.y,
        cell.radius * 0.35,
        cell.x,
        cell.y,
        ringRadius,
      );
      glow.addColorStop(0, faction.glow);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, ringRadius * pulse, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.fillStyle = "rgba(96, 73, 54, 0.16)";
      ctx.beginPath();
      ctx.ellipse(cell.x, cell.y + cell.radius * 0.8, cell.radius * 0.96, cell.radius * 0.44, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = faction.color;
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, cell.radius + 4, 0, Math.PI * 2);
      ctx.fill();

      const inner = ctx.createLinearGradient(
        cell.x,
        cell.y - cell.radius,
        cell.x,
        cell.y + cell.radius,
      );
      inner.addColorStop(0, cell.owner === OWNER_NEUTRAL ? "#fbf1dc" : "#fff9ef");
      inner.addColorStop(1, cell.owner === OWNER_NEUTRAL ? "#efddbf" : "#f4ead7");
      ctx.fillStyle = inner;
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, cell.radius - 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
      ctx.beginPath();
      ctx.ellipse(
        cell.x - cell.radius * 0.18,
        cell.y - cell.radius * 0.22,
        cell.radius * 0.42,
        cell.radius * 0.24,
        -0.25,
        0,
        Math.PI * 2,
      );
      ctx.fill();

      ctx.strokeStyle = "rgba(110, 86, 61, 0.22)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, cell.radius - 4, 0, Math.PI * 2);
      ctx.stroke();

      const petalRadius = cell.radius + 10;
      const petalCount = cell.size === "large" ? 6 : cell.size === "medium" ? 4 : 3;
      ctx.fillStyle = `${faction.color}bb`;
      for (let i = 0; i < petalCount; i += 1) {
        const angle = (Math.PI * 2 * i) / petalCount + cell.pulseOffset * 0.05;
        const px = cell.x + Math.cos(angle) * petalRadius;
        const py = cell.y + Math.sin(angle) * petalRadius;
        ctx.beginPath();
        ctx.arc(px, py, cell.size === "large" ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();
      }

      const ratio = clamp(cell.population / cell.capacity, 0, 1);
      ctx.strokeStyle = "rgba(114, 92, 69, 0.16)";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, cell.radius + 7, -Math.PI / 2, Math.PI * 1.5);
      ctx.stroke();
      ctx.strokeStyle = faction.color;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(
        cell.x,
        cell.y,
        cell.radius + 7,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * ratio,
      );
      ctx.stroke();

      ctx.fillStyle = "#4a382b";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `700 ${cell.size === "large" ? 26 : cell.size === "medium" ? 22 : 18}px "Trebuchet MS", "Gill Sans", sans-serif`;
      ctx.fillText(cell.population.toString(), cell.x, cell.y + 1);
    }
  }

  drawSwarms(ctx) {
    for (const swarm of this.simulation.swarms) {
      const faction = FACTIONS[swarm.owner] ?? FACTIONS.neutral;
      const progress = clamp(swarm.elapsed / swarm.travelTime, 0, 1);
      const x = swarm.fromX + (swarm.toX - swarm.fromX) * progress;
      const y = swarm.fromY + (swarm.toY - swarm.fromY) * progress;
      const angle = Math.atan2(swarm.toY - swarm.fromY, swarm.toX - swarm.fromX);

      ctx.save();
      ctx.strokeStyle = "rgba(155, 128, 100, 0.15)";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(swarm.fromX, swarm.fromY);
      ctx.lineTo(x, y);
      ctx.stroke();

      for (let i = 0; i < 3; i += 1) {
        const trailProgress = clamp(progress - i * 0.045, 0, 1);
        const tx = swarm.fromX + (swarm.toX - swarm.fromX) * trailProgress;
        const ty = swarm.fromY + (swarm.toY - swarm.fromY) * trailProgress;
        ctx.fillStyle = `${faction.color}${i === 0 ? "ff" : i === 1 ? "cc" : "88"}`;
        ctx.beginPath();
        ctx.arc(tx, ty, 8 - i * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = faction.color;
      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.quadraticCurveTo(2, -9, -5, -1);
      ctx.quadraticCurveTo(0, 0, -5, 1);
      ctx.quadraticCurveTo(2, 9, 11, 0);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.beginPath();
      ctx.arc(2, 0, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = "rgba(255, 249, 235, 0.96)";
      ctx.strokeStyle = "rgba(113, 88, 63, 0.16)";
      ctx.lineWidth = 1.5;
      const label = swarm.count.toString();
      ctx.font = '700 12px "Trebuchet MS", "Gill Sans", sans-serif';
      const labelWidth = Math.max(20, ctx.measureText(label).width + 12);
      const labelX = x - labelWidth / 2;
      const labelY = y - 24;
      ctx.beginPath();
      ctx.roundRect(labelX, labelY, labelWidth, 18, 9);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#4a382b";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x, labelY + 9);
      ctx.restore();
    }
  }

  drawEffects(ctx) {
    for (const effect of this.effects) {
      const progress = 1 - effect.life / effect.maxLife;
      ctx.save();
      ctx.strokeStyle = effect.color;
      ctx.globalAlpha = clamp(1 - progress, 0, 1);
      ctx.lineWidth = effect.type === "capture" ? 6 : 3;
      ctx.beginPath();
      ctx.arc(effect.x, effect.y, effect.radius + progress * 32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.34)";
      ctx.beginPath();
      ctx.arc(effect.x, effect.y, 6 + progress * 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  drawSelection(ctx) {
    const selected = this.selectedCellId ? this.simulation.getCell(this.selectedCellId) : null;
    if (selected && selected.owner === "player") {
      ctx.save();
      ctx.strokeStyle = "#fffdf5";
      ctx.lineWidth = 4;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, selected.radius + 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (this.pointer.isDown && this.dragSourceIds.length > 0) {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 245, 0.92)";
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 10]);
      for (const sourceId of this.dragSourceIds) {
        const source = this.simulation.getCell(sourceId);
        if (!source) {
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(this.pointer.x, this.pointer.y);
        ctx.stroke();

        ctx.strokeStyle = "rgba(255, 255, 245, 0.78)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(source.x, source.y, source.radius + 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255, 255, 245, 0.92)";
        ctx.lineWidth = 4;
      }
      ctx.setLineDash([]);

      if (this.hoverTargetId) {
        const target = this.simulation.getCell(this.hoverTargetId);
        const preview = this.getLaunchPreview(this.dragSourceIds, this.hoverTargetId);
        if (target) {
          ctx.strokeStyle =
            target.owner === "player"
              ? "#84c873"
              : preview?.capture
                ? "#84c873"
                : "#df836f";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(target.x, target.y, target.radius + 16, 0, Math.PI * 2);
          ctx.stroke();

          if (preview) {
            const label =
              target.owner === "player"
                ? `+${preview.totalUnits}`
                : `${preview.totalUnits}`;
            ctx.fillStyle =
              target.owner === "player"
                ? "rgba(232, 247, 221, 0.96)"
                : preview.capture
                  ? "rgba(232, 247, 221, 0.96)"
                  : "rgba(251, 233, 225, 0.96)";
            ctx.strokeStyle = "rgba(113, 88, 63, 0.18)";
            ctx.lineWidth = 1.5;
            ctx.font = '700 13px "Trebuchet MS", "Gill Sans", sans-serif';
            const width = Math.max(30, ctx.measureText(label).width + 16);
            ctx.beginPath();
            ctx.roundRect(target.x - width / 2, target.y - target.radius - 32, width, 18, 9);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#4a382b";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, target.x, target.y - target.radius - 23);
          }
        }
      }
      ctx.restore();
    }
  }
}

const app = new FageWarsApp();
window.__FAGE_WARS_APP__ = app;
