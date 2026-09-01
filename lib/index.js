import { randomUUID } from "node:crypto";
import { readFile, rename, rm, rmdir, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

//#region node half
const DELETE_ENDPOINT = "/_dsh-awsome-plugin/session.delete";
const UNARCHIVE_ENDPOINT = "/_dsh-awsome-plugin/session.unarchive";
const FONTS_ENDPOINT = "/_dsh-awsome-plugin/fonts";
const DELETE_HEADER = "x-dsh-awsome-plugin-action";
const ACTION_HEADER_VALUE = "archived-session-maintenance";
const MAX_BODY_BYTES = 4096;

class DeleteSessionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "DeleteSessionError";
    this.status = status;
    this.code = code;
  }
}

function writeJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function trustedBrowserRequest(req) {
  if (req.headers[DELETE_HEADER] !== ACTION_HEADER_VALUE) return false;
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin") return false;
  const origin = req.headers.origin;
  const authority = req.headers.host;
  if (typeof origin !== "string" || typeof authority !== "string") return false;
  try {
    return new URL(origin).host.toLowerCase() === authority.toLowerCase();
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      throw new DeleteSessionError(413, "request-too-large", "request body is too large");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DeleteSessionError(400, "invalid-json", "request body must be valid JSON");
  }
}

function sessionIdFromBody(body) {
  const sessionId = body?.sessionId;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > 256 ||
    sessionId.trim() !== sessionId
  ) {
    throw new DeleteSessionError(400, "invalid-session-id", "sessionId is invalid");
  }
  return sessionId;
}

function assertJsonlLocation(location) {
  if (
    location?.kind !== "jsonl" ||
    typeof location.path !== "string" ||
    !isAbsolute(location.path) ||
    !["session.jsonl", "session.jsonl.zstd"].includes(basename(location.path))
  ) {
    throw new DeleteSessionError(
      501,
      "unsupported-persistence",
      "permanent deletion currently supports the local JSONL session backend only",
    );
  }
  return location.path;
}

/**
 * Capture handles returned by AgentRegistry.create/resume. DSH deliberately
 * exposes arbitrary teardown only to the handle owner; keeping these handles
 * is what lets deletion stop, drain, flush, and detach an idle live session
 * before its local artifact is removed.
 */
function captureAgentHandles(agents, handles) {
  const restorers = [];
  for (const methodName of ["create", "resume"]) {
    const original = agents[methodName];
    if (typeof original !== "function") continue;
    const ownDescriptor = Object.getOwnPropertyDescriptor(agents, methodName);
    const patched = async function (...args) {
      const handle = await Reflect.apply(original, agents, args);
      const id = String(handle.agent.id);
      let disposal;
      const tracked = {
        agent: handle.agent,
        dispose() {
          disposal ??= Promise.resolve(handle.dispose()).finally(() => {
            if (handles.get(id) === tracked) handles.delete(id);
          });
          return disposal;
        },
      };
      handles.set(id, tracked);
      return tracked;
    };
    Object.defineProperty(agents, methodName, {
      configurable: true,
      writable: true,
      value: patched,
    });
    restorers.push(() => {
      if (agents[methodName] !== patched) return;
      if (ownDescriptor === undefined) delete agents[methodName];
      else Object.defineProperty(agents, methodName, ownDescriptor);
    });
  }
  return () => {
    for (const restore of restorers.reverse()) restore();
  };
}

async function restoreStagedLog(stagedPath, targetPath, workspaces, sessionId) {
  await rename(stagedPath, targetPath);
  for (const workspace of workspaces) await workspace.attachSession(sessionId);
}

function replaceArchivedSessionIds(registry, transform) {
  if (
    typeof registry.enqueueOperation !== "function" ||
    typeof registry.requireState !== "function" ||
    typeof registry.setState !== "function"
  ) {
    throw new DeleteSessionError(
      501,
      "unsupported-workspace-registry",
      "this DSH build does not expose archive maintenance primitives",
    );
  }
  return registry.enqueueOperation(async () => {
    const state = registry.requireState();
    const archivedSessionIds = transform([...state.archivedSessionIds]);
    if (
      archivedSessionIds.length === state.archivedSessionIds.length &&
      archivedSessionIds.every((id, index) => id === state.archivedSessionIds[index])
    ) {
      return [...state.archivedSessionIds];
    }
    await registry.setState({ ...state, archivedSessionIds });
    return [...archivedSessionIds];
  });
}

function unarchiveSession(ctx, sessionId) {
  return replaceArchivedSessionIds(ctx.workspaceRegistry, (ids) =>
    ids.filter((id) => String(id) !== sessionId),
  );
}

function createDeleteSession(ctx, handles) {
  const inflight = new Set();
  return async function deleteSession(sessionId) {
    if (inflight.has(sessionId)) {
      throw new DeleteSessionError(409, "delete-in-progress", "session deletion is already in progress");
    }
    inflight.add(sessionId);
    try {
      const headers = await ctx.sessionPersistence.list();
      const header = headers.find((candidate) => String(candidate.id) === sessionId);
      if (header === undefined) {
        throw new DeleteSessionError(404, "session-not-found", "local session was not found");
      }
      if (!ctx.workspaceRegistry.archivedSessionIds.some((id) => String(id) === sessionId)) {
        throw new DeleteSessionError(
          409,
          "session-not-archived",
          "only archived sessions can be permanently cleaned up",
        );
      }
      const child = headers.find((candidate) => String(candidate.parentSession) === sessionId);
      if (child !== undefined) {
        throw new DeleteSessionError(
          409,
          "session-has-children",
          "delete this session's child sessions first",
        );
      }

      const liveAgent = ctx.agents.get(sessionId);
      if (liveAgent?.status === "running") {
        throw new DeleteSessionError(409, "session-running", "stop the running session before deleting it");
      }
      const liveSession = ctx.sessions.get(sessionId);
      if (liveAgent !== undefined || liveSession !== undefined) {
        const handle = handles.get(sessionId);
        if (handle === undefined || handle.agent !== liveAgent) {
          throw new DeleteSessionError(
            409,
            "session-not-owned",
            "this live session predates the deletion plugin; restart DSH, then delete it before running it again",
          );
        }
        await handle.dispose();
        if (ctx.agents.get(sessionId) !== undefined || ctx.sessions.get(sessionId) !== undefined) {
          throw new DeleteSessionError(409, "session-still-live", "the session did not finish unloading");
        }
      }

      const targetPath = assertJsonlLocation(ctx.sessionPersistence.locate(header));
      const sessionDirectory = dirname(targetPath);
      const stagedPath = join(sessionDirectory, `.delete-${randomUUID()}.tmp`);
      const workspaces = ctx.workspaceRegistry
        .list()
        .filter((workspace) => workspace.sessionIds.some((id) => String(id) === sessionId));
      const previousArchivedSessionIds = [...ctx.workspaceRegistry.archivedSessionIds];

      try {
        await rename(targetPath, stagedPath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new DeleteSessionError(404, "session-not-found", "local session log no longer exists");
        }
        throw error;
      }

      try {
        for (const workspace of workspaces) await workspace.detachSession(sessionId);
      } catch (error) {
        await rename(stagedPath, targetPath);
        throw error;
      }

      try {
        await unarchiveSession(ctx, sessionId);
      } catch (error) {
        await restoreStagedLog(stagedPath, targetPath, workspaces, sessionId);
        throw error;
      }

      try {
        await rm(stagedPath);
      } catch (error) {
        try {
          await restoreStagedLog(stagedPath, targetPath, workspaces, sessionId);
          await replaceArchivedSessionIds(
            ctx.workspaceRegistry,
            () => previousArchivedSessionIds,
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "failed to remove the staged session log and failed to restore it",
          );
        }
        throw error;
      }

      try {
        await rmdir(sessionDirectory);
      } catch (error) {
        if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") {
          console.warn(
            `[dsh-awsome-plugin] removed session log but could not remove its empty directory: ${String(error)}`,
          );
        }
      }
      return { sessionId };
    } finally {
      inflight.delete(sessionId);
    }
  };
}

function fontsFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "dsh-awsome-plugin-fonts.json");
}

function normalizeFontSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size === 0 || size === 100) return 0;
  return Math.min(200, Math.max(70, Math.round(size)));
}

function normalizeFontPreference(value) {
  const ui = typeof value?.ui === "string" ? value.ui.trim() : "";
  const code = typeof value?.code === "string" ? value.code.trim() : "";
  return {
    ui: ui.length <= 200 ? ui : ui.slice(0, 200),
    code: code.length <= 200 ? code : code.slice(0, 200),
    size: normalizeFontSize(value?.size),
  };
}

async function readFontPreferenceFile() {
  try {
    return normalizeFontPreference(JSON.parse(await readFile(fontsFilePath(), "utf8")));
  } catch {
    return { ui: "", code: "", size: 0 };
  }
}

async function writeFontPreferenceFile(preference) {
  const path = fontsFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(preference, null, 2)}\n`, "utf8");
  return preference;
}

function registerFontsRoute(ctx) {
  return ctx.webServer.register({
    kind: "exact",
    path: FONTS_ENDPOINT,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      if (!trustedBrowserRequest(req)) {
        writeJson(res, 403, { ok: false, code: "forbidden", message: "forbidden" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        if (body?.op === "get") {
          writeJson(res, 200, { ok: true, value: await readFontPreferenceFile() });
          return;
        }
        const preference = await writeFontPreferenceFile(normalizeFontPreference(body));
        writeJson(res, 200, { ok: true, value: preference });
      } catch (error) {
        if (error instanceof DeleteSessionError) {
          writeJson(res, error.status, { ok: false, code: error.code, message: error.message });
          return;
        }
        console.error("[dsh-awsome-plugin] font preference failed:", error);
        writeJson(res, 500, {
          ok: false,
          code: "internal",
          message: "font preference failed",
        });
      }
    },
  });
}

function registerJsonRoute(ctx, path, operation, failureMessage) {
  return ctx.webServer.register({
    kind: "exact",
    path,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      if (!trustedBrowserRequest(req)) {
        writeJson(res, 403, { ok: false, code: "forbidden", message: "forbidden" });
        return;
      }
      try {
        const sessionId = sessionIdFromBody(await readJsonBody(req));
        writeJson(res, 200, { ok: true, value: await operation(sessionId) });
      } catch (error) {
        if (error instanceof DeleteSessionError) {
          writeJson(res, error.status, { ok: false, code: error.code, message: error.message });
          return;
        }
        console.error(`[dsh-awsome-plugin] ${failureMessage}:`, error);
        writeJson(res, 500, {
          ok: false,
          code: "internal",
          message: failureMessage,
        });
      }
    },
  });
}

/**
 * dsh-awsome-plugin, node half. Besides serving the browser bundle, it owns a
 * same-origin endpoint for permanent local session deletion.
 */
function apply(ctx) {
  const handles = new Map();
  const restoreAgentMethods = captureAgentHandles(ctx.agents, handles);
  const deleteSession = createDeleteSession(ctx, handles);

  ctx.effect(() => restoreAgentMethods, "dsh-awsome-plugin: restore agent methods");
  ctx.effect(
    () => registerJsonRoute(ctx, DELETE_ENDPOINT, deleteSession, "permanent session cleanup failed"),
    `dsh-awsome-plugin: ${DELETE_ENDPOINT}`,
  );
  ctx.effect(
    () =>
      registerJsonRoute(
        ctx,
        UNARCHIVE_ENDPOINT,
        async (sessionId) => ({
          sessionId,
          archivedSessionIds: await unarchiveSession(ctx, sessionId),
        }),
        "session unarchive failed",
      ),
    `dsh-awsome-plugin: ${UNARCHIVE_ENDPOINT}`,
  );
  ctx.effect(
    () => registerFontsRoute(ctx),
    `dsh-awsome-plugin: ${FONTS_ENDPOINT}`,
  );
}
//#endregion

const inject = ["webServer", "sessionPersistence", "sessions", "agents", "workspaceRegistry"];

export { DELETE_ENDPOINT, FONTS_ENDPOINT, UNARCHIVE_ENDPOINT, apply, inject };
