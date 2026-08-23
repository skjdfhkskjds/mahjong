import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyDiscordActivityInstance } from "../../src/worker/integrations/discord/discord-activity-instance.js";

const request = {
  applicationId: "1215413995645968394",
  botToken: "discord-bot-token",
  instanceId: "instance/with spaces?#%",
  userId: "205519959982473217",
} as const;

const validInstance = {
  application_id: request.applicationId,
  instance_id: request.instanceId,
  launch_id: "1276580072400224306",
  location: {
    channel_id: "912954213460484116",
    guild_id: "912952092627435520",
    id: "gc-912952092627435520-912954213460484116",
    kind: "gc",
  },
  users: ["111111111111111111", request.userId],
};

function stubDiscord(
  response: Response,
): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchImplementation = vi.fn<typeof fetch>();
  fetchImplementation.mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchImplementation);
  return fetchImplementation;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Discord Activity instance verification", () => {
  it("encodes the opaque instance ID and authenticates with the Bot scheme", async () => {
    const fetchImplementation = stubDiscord(Response.json(validInstance));

    await expect(verifyDiscordActivityInstance(request)).resolves.toEqual({
      applicationId: request.applicationId,
      instanceId: request.instanceId,
      userIds: validInstance.users,
    });
    expect(fetchImplementation).toHaveBeenCalledExactlyOnceWith(
      "https://discord.com/api/v10/applications/1215413995645968394/activity-instances/instance%2Fwith%20spaces%3F%23%25",
      {
        headers: { Authorization: "Bot discord-bot-token" },
        method: "GET",
      },
    );
  });

  it.each([
    ["another application", { ...validInstance, application_id: "999" }],
    ["another instance", { ...validInstance, instance_id: "another" }],
    ["a missing users field", { ...validInstance, users: undefined }],
    ["a non-array users field", { ...validInstance, users: request.userId }],
    ["a malformed user ID", { ...validInstance, users: [request.userId, 1] }],
    ["no authenticated user", { ...validInstance, users: ["111"] }],
  ])("rejects a response for %s", async (_description, body) => {
    stubDiscord(Response.json(body));

    await expect(verifyDiscordActivityInstance(request)).rejects.toThrow(
      "Discord Activity instance verification failed.",
    );
  });

  it("rejects a malformed JSON response", async () => {
    stubDiscord(
      new Response("{", {
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(verifyDiscordActivityInstance(request)).rejects.toThrow(
      "Discord Activity instance verification failed.",
    );
  });

  it.each([400, 401, 403, 404, 429, 500])(
    "rejects HTTP %i even when the body looks valid",
    async (status) => {
      stubDiscord(Response.json(validInstance, { status }));

      await expect(verifyDiscordActivityInstance(request)).rejects.toThrow(
        "Discord Activity instance verification failed.",
      );
    },
  );

  it("rejects invalid inputs without contacting Discord", async () => {
    const fetchImplementation = stubDiscord(Response.json(validInstance));

    await expect(
      verifyDiscordActivityInstance({ ...request, applicationId: "not-an-id" }),
    ).rejects.toThrow("Discord Activity instance verification failed.");
    await expect(
      verifyDiscordActivityInstance({ ...request, instanceId: "" }),
    ).rejects.toThrow("Discord Activity instance verification failed.");
    await expect(
      verifyDiscordActivityInstance({ ...request, userId: "not-an-id" }),
    ).rejects.toThrow("Discord Activity instance verification failed.");
    await expect(
      verifyDiscordActivityInstance({ ...request, botToken: " token " }),
    ).rejects.toThrow("Discord Activity instance verification failed.");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
