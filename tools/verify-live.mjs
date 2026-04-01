import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const workspace = process.cwd();
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9222;
const appPort = 8787;
const userDataDir = "/tmp/fage-wars-verify-profile";
const targetUrl = `http://127.0.0.1:${appPort}/index.html`;
const screenshotsDir = path.join(workspace, "qa");
const homeShot = path.join(screenshotsDir, "home.png");
const gameShot = path.join(screenshotsDir, "gameplay.png");
const groupedPreviewShot = path.join(screenshotsDir, "grouped-preview.png");
const groupedShot = path.join(screenshotsDir, "grouped-drag.png");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 50) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw lastError;
}

class CDPClient {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];

    this.openPromise = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      this.events.push(message);
    });
  }

  async open() {
    await this.openPromise;
  }

  close() {
    this.socket.close();
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    const payload = { id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify(payload));
    return promise;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
    }
    return result.result?.value;
  }
}

async function waitFor(client, predicateExpression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = await client.evaluate(predicateExpression);
    if (matched) {
      return matched;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for: ${predicateExpression}`);
}

async function dispatchClick(client, x, y) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function dispatchDrag(client, from, to) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.x,
    y: from.y,
    button: "none",
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    button: "left",
    clickCount: 1,
  });

  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      button: "left",
    });
    await sleep(16);
  }

  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.x,
    y: to.y,
    button: "left",
    clickCount: 1,
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  await fs.mkdir(screenshotsDir, { recursive: true });
  const server = http.createServer(async (request, response) => {
    const requestPath = request.url === "/" ? "/index.html" : request.url;
    const filePath = path.join(workspace, decodeURIComponent(requestPath.split("?")[0]));

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      const type =
        ext === ".html"
          ? "text/html"
          : ext === ".js"
            ? "text/javascript"
            : ext === ".css"
              ? "text/css"
              : "application/octet-stream";
      response.writeHead(200, { "Content-Type": type });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(appPort, "127.0.0.1", resolve);
  });

  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
      "--window-size=1440,980",
      targetUrl,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let chromeLog = "";
  chrome.stdout.on("data", (chunk) => {
    chromeLog += chunk.toString();
  });
  chrome.stderr.on("data", (chunk) => {
    chromeLog += chunk.toString();
  });

  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const pageTarget = targets.find((target) => target.url === targetUrl) ?? targets[0];
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("No debuggable page target found");
    }

    const client = new CDPClient(pageTarget.webSocketDebuggerUrl);
    await client.open();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");

    await waitFor(client, "document.readyState === 'complete'");
    await waitFor(client, "Boolean(window.__FAGE_WARS_APP__)");
    await sleep(400);

    const initial = await client.evaluate(`(() => ({
      cards: document.querySelectorAll('.level-card').length,
      menuOpen: !document.querySelector('#menu-overlay').classList.contains('overlay--hidden'),
      title: document.querySelector('h1')?.textContent ?? null
    }))()`);

    const homeCapture = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    await fs.writeFile(homeShot, Buffer.from(homeCapture.data, "base64"));

    const firstCard = await client.evaluate(`(() => {
      const card = [...document.querySelectorAll('.level-card')]
        .find((node) => !node.classList.contains('is-locked'));
      if (!card) return null;
      const rect = card.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!firstCard) {
      throw new Error("No unlocked campaign card found");
    }

    await dispatchClick(client, firstCard.x, firstCard.y);
    await waitFor(
      client,
      "document.querySelector('#menu-overlay').classList.contains('overlay--hidden')",
      5000,
    );

    const orderPlan = await client.evaluate(`(() => {
      const app = window.__FAGE_WARS_APP__;
      const sim = app.simulation;
      app.ai.update = () => {};
      app.__verifyOriginalUpdate = sim.update.bind(sim);
      sim.update = () => {};
      sim.setSpeed(1);
      const playerCells = sim.cells.filter((cell) => cell.owner === 'player');
      if (playerCells.length === 0) return null;
      const source = [...playerCells].sort((a, b) => b.population - a.population)[0];
      const sendCount = sim.getSendableCount(source);
      const targets = sim.cells
        .filter((cell) => cell.owner === 'neutral' && sendCount >= cell.population)
        .map((cell) => ({
          id: cell.id,
          owner: cell.owner,
          x: cell.x,
          y: cell.y,
          population: cell.population,
          distance: Math.hypot(cell.x - source.x, cell.y - source.y),
        }))
        .sort((a, b) => a.distance - b.distance);
      const target = targets[0];
      return {
        source: { id: source.id, x: source.x, y: source.y, population: source.population },
        target,
        sendCount,
      };
    })()`);
    if (!orderPlan?.source || !orderPlan?.target || !orderPlan.sendCount) {
      throw new Error("Unable to build a deterministic capture order");
    }

    await dispatchDrag(client, orderPlan.source, orderPlan.target);
    await sleep(200);

    const ratioLaunch = await client.evaluate(`(() => ({
      commandCount: window.__FAGE_WARS_APP__.simulation.commandCount,
      swarms: window.__FAGE_WARS_APP__.simulation.swarms.length,
      selected: window.__FAGE_WARS_APP__.selectedCellId,
      sourcePopulation: window.__FAGE_WARS_APP__.simulation.getCell('${orderPlan.source.id}')?.population ?? null,
      allIntegers: window.__FAGE_WARS_APP__.simulation.cells.every((cell) => Number.isInteger(cell.population)),
    }))()`);

    assert(ratioLaunch.commandCount === 1, "Expected one order during ratio test");
    assert(ratioLaunch.sourcePopulation === orderPlan.source.population - orderPlan.sendCount, "Source population did not drop by exact send count");
    assert(ratioLaunch.allIntegers, "Cell populations were not integer-valued after launch");
    await client.evaluate("window.__FAGE_WARS_APP__.simulation.update = window.__FAGE_WARS_APP__.__verifyOriginalUpdate");

    await waitFor(
      client,
      `(() => {
        const sim = window.__FAGE_WARS_APP__.simulation;
        const target = sim.cells.find((cell) => cell.id === '${orderPlan.target.id}');
        return target && (target.owner === 'player' || sim.swarms.length === 0);
      })()`,
      7000,
    );

    const ratioPost = await client.evaluate(`(() => {
      const app = window.__FAGE_WARS_APP__;
      const sim = app.simulation;
      const target = sim.cells.find((cell) => cell.id === '${orderPlan.target.id}');
      return {
        mapChip: document.querySelector('#map-chip')?.textContent ?? null,
        targetOwner: target?.owner ?? null,
        targetPopulation: target ? Math.floor(target.population) : null,
        playerCells: sim.cells.filter((cell) => cell.owner === 'player').length,
        status: sim.status,
        allIntegers: sim.cells.every((cell) => Number.isInteger(cell.population)) && sim.swarms.every((swarm) => Number.isInteger(swarm.count)),
      };
    })()`);

    assert(ratioPost.targetOwner === "player", "Deterministic ratio test did not capture the neutral cell");
    assert(ratioPost.targetPopulation === Math.max(1, orderPlan.sendCount - orderPlan.target.population), "Captured cell garrison did not match exact damage math");
    assert(ratioPost.allIntegers, "Integer combat verification failed after arrival");

    const gameplayCapture = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    await fs.writeFile(gameShot, Buffer.from(gameplayCapture.data, "base64"));

    await client.evaluate("window.__FAGE_WARS_APP__.startLevel(4)");
    await waitFor(client, "window.__FAGE_WARS_APP__.currentMapIndex === 4", 4000);
    await client.evaluate(`(() => {
      const app = window.__FAGE_WARS_APP__;
      app.ai.update = () => {};
      app.__verifyOriginalUpdate = app.simulation.update.bind(app.simulation);
      app.simulation.update = () => {};
      app.simulation.setSpeed(1);
      return true;
    })()`);
    await sleep(200);

    const groupedPlan = await client.evaluate(`(() => {
      const sim = window.__FAGE_WARS_APP__.simulation;
      const p0 = sim.getCell('p0');
      const p1 = sim.getCell('p1');
      const target = sim.getCell('n4');
      return {
        sourceA: { id: p0.id, x: p0.x, y: p0.y, sendable: sim.getSendableCount(p0) },
        sourceB: { id: p1.id, x: p1.x, y: p1.y, sendable: sim.getSendableCount(p1) },
        target: { id: target.id, x: target.x, y: target.y, population: target.population },
      };
    })()`);

    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: groupedPlan.sourceA.x,
      y: groupedPlan.sourceA.y,
      button: "none",
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: groupedPlan.sourceA.x,
      y: groupedPlan.sourceA.y,
      button: "left",
      clickCount: 1,
    });
    for (let step = 1; step <= 10; step += 1) {
      const t = step / 10;
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: groupedPlan.sourceA.x + (groupedPlan.sourceB.x - groupedPlan.sourceA.x) * t,
        y: groupedPlan.sourceA.y + (groupedPlan.sourceB.y - groupedPlan.sourceA.y) * t,
        button: "left",
      });
      await sleep(16);
    }

    await waitFor(client, "window.__FAGE_WARS_APP__.dragSourceIds.length === 2", 3000);
    await waitFor(
      client,
      "document.querySelector('#selection-panel') && document.querySelector('#selection-panel').textContent.includes('Launch') && document.querySelector('#selection-panel').textContent.includes('Shot')",
      3000,
    );

    const groupedPreview = await client.evaluate(`(() => ({
      dragCount: window.__FAGE_WARS_APP__.dragSourceIds.length,
      panelText: document.querySelector('#selection-panel')?.textContent ?? null
    }))()`);

    assert(groupedPreview.dragCount === 2, "Sweep-drag did not pick up both friendly cells");

    const groupedPreviewCapture = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    await fs.writeFile(groupedPreviewShot, Buffer.from(groupedPreviewCapture.data, "base64"));

    for (let step = 1; step <= 12; step += 1) {
      const t = step / 12;
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: groupedPlan.sourceB.x + (groupedPlan.target.x - groupedPlan.sourceB.x) * t,
        y: groupedPlan.sourceB.y + (groupedPlan.target.y - groupedPlan.sourceB.y) * t,
        button: "left",
      });
      await sleep(16);
    }
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: groupedPlan.target.x,
      y: groupedPlan.target.y,
      button: "left",
      clickCount: 1,
    });

    await sleep(200);

    const groupedLaunch = await client.evaluate(`(() => ({
      commandCount: window.__FAGE_WARS_APP__.simulation.commandCount,
      swarmsToTarget: window.__FAGE_WARS_APP__.simulation.swarms.filter((swarm) => swarm.targetId === '${groupedPlan.target.id}').length,
      targetOwner: window.__FAGE_WARS_APP__.simulation.getCell('${groupedPlan.target.id}')?.owner ?? null,
      allIntegers: window.__FAGE_WARS_APP__.simulation.cells.every((cell) => Number.isInteger(cell.population)),
    }))()`);

    assert(groupedLaunch.commandCount === 2, "Grouped drag did not emit two one-shot orders");
    assert(groupedLaunch.swarmsToTarget === 2, "Grouped drag did not send both swarms to the same target");
    assert(groupedLaunch.allIntegers, "Integer counts broke during grouped launch");
    await client.evaluate("window.__FAGE_WARS_APP__.simulation.update = window.__FAGE_WARS_APP__.__verifyOriginalUpdate");

    await waitFor(
      client,
      `(() => {
        const sim = window.__FAGE_WARS_APP__.simulation;
        const target = sim.getCell('${groupedPlan.target.id}');
        return target?.owner === 'player' || sim.swarms.length === 0;
      })()`,
      7000,
    );

    const groupedPost = await client.evaluate(`(() => {
      const sim = window.__FAGE_WARS_APP__.simulation;
      const target = sim.getCell('${groupedPlan.target.id}');
      return {
        targetOwner: target?.owner ?? null,
        targetPopulation: target?.population ?? null,
        allIntegers: sim.cells.every((cell) => Number.isInteger(cell.population)) && sim.swarms.every((swarm) => Number.isInteger(swarm.count)),
      };
    })()`);

    assert(groupedPost.targetOwner === "player", "Grouped launch did not capture the test target");
    assert(groupedPost.allIntegers, "Integer counts broke after grouped capture");

    const groupedCapture = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    await fs.writeFile(groupedShot, Buffer.from(groupedCapture.data, "base64"));

    const consoleIssues = client.events.filter(
      (event) =>
        event.method === "Log.entryAdded" &&
        ["error", "warning"].includes(event.params?.entry?.level),
    );

    console.log(
      JSON.stringify(
        {
          initial,
          ratioTest: {
            plan: orderPlan,
            launch: ratioLaunch,
            post: ratioPost,
          },
          groupedTest: {
            plan: groupedPlan,
            preview: groupedPreview,
            launch: groupedLaunch,
            post: groupedPost,
          },
          consoleIssues: consoleIssues.map((event) => event.params.entry.text),
          screenshots: {
            home: homeShot,
            gameplay: gameShot,
            groupedPreview: groupedPreviewShot,
            grouped: groupedShot,
          },
        },
        null,
        2,
      ),
    );

    client.close();
  } finally {
    chrome.kill("SIGKILL");
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
