import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELETE_ENDPOINT, UNARCHIVE_ENDPOINT, apply } from "../lib/index.js";

const root = mkdtempSync(join(tmpdir(), "dsh-session-delete-test-"));
const headers = [];
const paths = new Map();
const agentsById = new Map();
const sessionsById = new Map();
const workspaceIds = [];
const effects = [];
const routes = new Map();
let archiveState = {
  initialized: true,
  workspaceIds: [],
  archivedSessionIds: [],
};

function stageSession(id, status) {
  const directory = join(root, id);
  const path = join(directory, "session.jsonl");
  mkdirSync(directory, { recursive: true });
  const header = { id, cwd: root, createdAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify({ type: "session/header", data: header })}\n`);
  headers.push(header);
  paths.set(id, path);
  const session = { id, header };
  const agent = { id, status, session };
  agentsById.set(id, agent);
  sessionsById.set(id, session);
  workspaceIds.push(id);
  archiveState = {
    ...archiveState,
    archivedSessionIds: [...archiveState.archivedSessionIds, id],
  };
  return { path, agent, session };
}

const agents = {
  get(id) {
    return agentsById.get(id);
  },
  async create(options) {
    const agent = agentsById.get(options.sessionId);
    return {
      agent,
      async dispose() {
        agentsById.delete(agent.id);
        sessionsById.delete(agent.id);
      },
    };
  },
  async resume(options) {
    return this.create({ sessionId: options.resumeSessionId });
  },
};

const workspace = {
  get sessionIds() {
    return [...workspaceIds];
  },
  async detachSession(id) {
    const index = workspaceIds.indexOf(id);
    if (index >= 0) workspaceIds.splice(index, 1);
  },
  async attachSession(id) {
    if (!workspaceIds.includes(id)) workspaceIds.unshift(id);
  },
};

const ctx = {
  agents,
  sessions: {
    get(id) {
      return sessionsById.get(id);
    },
  },
  sessionPersistence: {
    async list() {
      return [...headers];
    },
    locate(header) {
      return { kind: "jsonl", path: paths.get(header.id) };
    },
  },
  workspaceRegistry: {
    get archivedSessionIds() {
      return archiveState.archivedSessionIds;
    },
    list() {
      return [workspace];
    },
    enqueueOperation(operation) {
      return operation();
    },
    requireState() {
      return archiveState;
    },
    async setState(state) {
      archiveState = state;
    },
  },
  webServer: {
    register(value) {
      routes.set(value.path, value);
      return () => {
        routes.delete(value.path);
      };
    },
  },
  effect(setup) {
    const dispose = setup();
    if (typeof dispose === "function") effects.push(dispose);
    return dispose;
  },
};

async function request(port, endpoint, sessionId) {
  const origin = `http://127.0.0.1:${port}`;
  return fetch(`${origin}${endpoint}`, {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-dsh-awsome-plugin-action": "archived-session-maintenance",
    },
    body: JSON.stringify({ sessionId }),
  });
}

let server;
try {
  apply(ctx);
  assert.equal(routes.get(DELETE_ENDPOINT)?.kind, "exact");
  assert.equal(routes.get(UNARCHIVE_ENDPOINT)?.kind, "exact");
  server = createServer((req, res) => routes.get(new URL(req.url, "http://test").pathname).handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const idle = stageSession("session-idle", "idle");
  await agents.create({ sessionId: idle.agent.id });
  const deleted = await request(port, DELETE_ENDPOINT, idle.agent.id);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), {
    ok: true,
    value: { sessionId: idle.agent.id },
  });
  assert.equal(existsSync(idle.path), false);
  assert.equal(agentsById.has(idle.agent.id), false);
  assert.equal(sessionsById.has(idle.agent.id), false);
  assert.equal(workspaceIds.includes(idle.agent.id), false);
  assert.equal(archiveState.archivedSessionIds.includes(idle.agent.id), false);

  const running = stageSession("session-running", "running");
  await agents.create({ sessionId: running.agent.id });
  const rejected = await request(port, DELETE_ENDPOINT, running.agent.id);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, "session-running");
  assert.equal(existsSync(running.path), true);
  assert.equal(agentsById.has(running.agent.id), true);
  assert.equal(workspaceIds.includes(running.agent.id), true);

  const restored = stageSession("session-unarchive", "idle");
  const unarchived = await request(port, UNARCHIVE_ENDPOINT, restored.agent.id);
  assert.equal(unarchived.status, 200);
  assert.equal(archiveState.archivedSessionIds.includes(restored.agent.id), false);
  assert.equal(existsSync(restored.path), true);

  console.log("delete-session test: OK — archived cleanup, running guard, and unarchive");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const dispose of effects.reverse()) await dispose();
  rmSync(root, { recursive: true, force: true });
}
