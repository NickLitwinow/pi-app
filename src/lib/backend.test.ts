import { describe, expect, it } from "vitest";
import { MockBackend } from "./backend";
import type { ConfigFile, SessionMeta } from "./types";

async function waitForResponses(
  backend: MockBackend,
  requests: { agentId: string; id: string }[],
): Promise<Record<string, Record<string, unknown>>> {
  const responses: Record<string, Record<string, unknown>> = {};
  const expected = new Set(requests.map(({ agentId, id }) => `${agentId}:${id}`));
  const unsubscribe = await backend.listen("agent-event", (payload) => {
    const event = payload.event as Record<string, unknown> | undefined;
    const key = `${String(payload.agentId)}:${String(event?.id)}`;
    if (event?.type === "response" && expected.has(key)) responses[key] = event;
  });
  try {
    await Promise.all(requests.map(({ agentId, id }) =>
      backend.invoke("agent_send", {
        agentId,
        line: JSON.stringify({ type: "get_state", id }),
      })));
    const deadline = Date.now() + 1_000;
    while (Object.keys(responses).length < requests.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return responses;
  } finally {
    unsubscribe();
  }
}

describe("MockBackend session isolation", () => {
  it("lists only sessions belonging to the requested workspace", async () => {
    const backend = new MockBackend();
    const pi = await backend.invoke<SessionMeta[]>("list_sessions_for_cwd", { cwd: "/Users/dev/pi-app" });
    const website = await backend.invoke<SessionMeta[]>("list_sessions_for_cwd", { cwd: "/Users/dev/website" });

    expect(pi).toHaveLength(6);
    expect(pi.every((session) => session.cwd === "/Users/dev/pi-app")).toBe(true);
    expect(website).toHaveLength(2);
    expect(website.map((session) => session.name)).toEqual([
      "Landing page accessibility",
      "Deploy preview",
    ]);
  });

  it("keeps session files and steering queues isolated per agent", async () => {
    const backend = new MockBackend();
    const piAgent = await backend.invoke<string>("spawn_agent", {
      opts: { cwd: "/Users/dev/pi-app", sessionPath: "/mock/a/s1.jsonl" },
    });
    const webAgent = await backend.invoke<string>("spawn_agent", {
      opts: { cwd: "/Users/dev/website", sessionPath: "/mock/b/deploy.jsonl" },
    });

    const queueEvents: Record<string, string[][]> = {};
    const unsubscribe = await backend.listen("agent-event", (payload) => {
      const event = payload.event as Record<string, unknown> | undefined;
      if (event?.type !== "queue_update") return;
      const agentId = String(payload.agentId);
      (queueEvents[agentId] ??= []).push((event.steering as string[] | undefined) ?? []);
    });
    await backend.invoke("agent_send", {
      agentId: piAgent,
      line: JSON.stringify({ type: "steer", message: "pi-only" }),
    });
    await backend.invoke("agent_send", {
      agentId: webAgent,
      line: JSON.stringify({ type: "steer", message: "web-only" }),
    });
    unsubscribe();

    const responses = await waitForResponses(backend, [
      { agentId: piAgent, id: "pi-state" },
      { agentId: webAgent, id: "web-state" },
    ]);
    const sessionFile = (agentId: string, id: string) =>
      ((responses[`${agentId}:${id}`]?.data as Record<string, unknown>)?.sessionFile);

    expect(sessionFile(piAgent, "pi-state")).toBe("/mock/a/s1.jsonl");
    expect(sessionFile(webAgent, "web-state")).toBe("/mock/b/deploy.jsonl");
    expect(queueEvents[piAgent]).toEqual([["pi-only"]]);
    expect(queueEvents[webAgent]).toEqual([["web-only"]]);
  });

  it("keeps project configs and permission modes scoped by cwd", async () => {
    const backend = new MockBackend();
    const websiteSettings = await backend.invoke<ConfigFile>("read_project_settings", {
      cwd: "/Users/dev/website",
    });
    expect(websiteSettings).toMatchObject({
      path: "/Users/dev/website/.pi/settings.json",
      content: "{}",
      exists: false,
    });

    await backend.invoke("write_project_pi_config", {
      cwd: "/Users/dev/website",
      name: "mcp",
      content: "{\"mcpServers\":{\"website-only\":{\"command\":\"node\"}}}",
    });
    const websiteMcp = await backend.invoke<ConfigFile>("read_project_pi_config", {
      cwd: "/Users/dev/website",
      name: "mcp",
    });
    const piMcp = await backend.invoke<ConfigFile>("read_project_pi_config", {
      cwd: "/Users/dev/pi-app",
      name: "mcp",
    });
    expect(websiteMcp.exists).toBe(true);
    expect(websiteMcp.content).toContain("website-only");
    expect(piMcp).toMatchObject({ content: "{}", exists: false });

    await backend.invoke("write_permission_preset", { cwd: "/Users/dev/pi-app", mode: "auto" });
    await backend.invoke("write_permission_preset", { cwd: "/Users/dev/website", mode: "ask" });
    await expect(backend.invoke("read_permission_mode", { cwd: "/Users/dev/pi-app" })).resolves.toBe("auto");
    await expect(backend.invoke("read_permission_mode", { cwd: "/Users/dev/website" })).resolves.toBe("ask");
  });

  it("fails closed when a resource toggle does not match the scoped package", async () => {
    const backend = new MockBackend();
    await expect(backend.invoke("set_extension_resource_enabled", {
      scope: "project",
      cwd: "/Users/dev/website",
      packageIdentifier: "pi-skill-code-review",
      kind: "skill",
      enabled: false,
    })).rejects.toThrow("package is not configured");
  });
});
