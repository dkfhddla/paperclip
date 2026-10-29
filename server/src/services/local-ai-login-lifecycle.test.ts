import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { localAiLoginService } from "./local-ai-login.js";

const mocks = vi.hoisted(() => ({ abort: vi.fn(), credential: vi.fn() }));
vi.mock("./local-ai-browser-login.js", () => ({
  startLocalBrowserLogin: () => ({ outcome: "success", abort: mocks.abort }),
}));
vi.mock("./local-ai-credentials.js", () => ({ readVerifiedLocalAiCredential: mocks.credential }));
vi.mock("./ai-connections.js", () => ({ aiConnectionService: vi.fn() }));
vi.mock("./activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("./delivery-work-notifications.js", () => ({
  DELIVERY_QUEUES: { localLoginCleanup: "local-login-cleanup" }, notifyDeliveryWork: vi.fn(),
}));

let root: string | undefined;
afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function fakeDb() {
  const results: unknown[][] = [[], [], [{ id: "local-environment" }]];
  const update = vi.fn(() => ({ set: () => ({ where: async () => {} }) }));
  const db = {
    select: () => {
      const rows = results.shift() ?? [];
      const query = {
        from: () => query, where: () => query, orderBy: () => query,
        limit: () => query, for: () => query,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return query;
    },
    execute: async () => {},
    insert: () => ({ values: async () => {} }),
    update,
    transaction: async <T>(fn: (tx: Db) => Promise<T>) => fn(db as unknown as Db),
  };
  return { db: db as unknown as Db, results, update };
}

describe("local sign-in completion and cleanup", () => {
  it("retains a failed cancellation for retry and requires verified credentials to report ready", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-login-lifecycle-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "windows-test");
    const { db, results, update } = fakeDb();
    const service = localAiLoginService(db);
    const intent = { provider: "openai", method: "subscription", name: "Windows fixture", ownership: "personal", allAgents: false, agentIds: [] } as const;
    const mutableIntent = { ...intent, agentIds: [] as string[] };
    const attempt = await service.start("company", "owner", mutableIntent);
    const homes = path.join(root, "instances", "windows-test", "ai-local-logins");
    expect(await readdir(homes)).toEqual([attempt.sessionId]);
    const session = { id: attempt.sessionId, aiConnection: mutableIntent, status: "waiting_for_user", expiresAt: new Date(attempt.expiresAt) };
    results.push([session]);
    mocks.credential.mockRejectedValueOnce(new Error("fixture has no credentials"));
    await expect(service.check("company", "owner", mutableIntent, attempt.sessionId)).resolves.toEqual({ status: "sign_in_required", authorizationUrl: undefined, code: undefined });
    results.push([session]);
    mocks.credential.mockResolvedValueOnce("fixture-verified-only");
    await expect(service.check("company", "owner", mutableIntent, attempt.sessionId)).resolves.toEqual({ status: "ready" });
    results.push([session]);
    mocks.abort.mockRejectedValueOnce(new Error("Local sign-in cleanup failed"));
    await expect(service.cancel("company", "owner", attempt.sessionId)).rejects.toThrow("cleanup failed");
    await expect(access(path.join(homes, attempt.sessionId))).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    results.push([session]);
    mocks.abort.mockResolvedValueOnce(undefined);
    await service.cancel("company", "owner", attempt.sessionId);
    expect(mocks.abort).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledOnce();
    await expect(access(path.join(homes, attempt.sessionId))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
