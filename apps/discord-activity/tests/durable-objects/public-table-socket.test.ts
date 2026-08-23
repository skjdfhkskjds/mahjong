import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const origin = "https://activity.example";

interface SnapshotMessage {
  readonly protocolVersion: 1;
  readonly stateVersion: number;
  readonly type: "table/snapshot";
  readonly view: {
    readonly phase: "lobby";
    readonly seats: readonly {
      readonly occupant: {
        readonly displayName: string;
        readonly id: string;
      } | null;
      readonly ready: boolean;
      readonly seat: string;
    }[];
    readonly spectators: readonly {
      readonly displayName: string;
      readonly id: string;
    }[];
    readonly tableId: string;
    readonly viewer: {
      readonly actor: { readonly displayName: string; readonly id: string };
      readonly role: "player" | "spectator";
      readonly seat?: string;
    };
  };
}

interface ReceiptMessage {
  readonly commandId: string;
  readonly outcome: "applied" | "rejected";
  readonly protocolVersion: 1;
  readonly stateVersion: number;
  readonly type: "table/receipt";
}

interface AuthenticatedSession {
  readonly access: "join-required" | "member";
  readonly actor: { readonly displayName: string; readonly id: string };
  readonly authenticated: true;
  readonly csrfToken: string;
  readonly role?: "member" | "owner";
  readonly tableId: string;
}

function nextMessage(socket: WebSocket): Promise<SnapshotMessage> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          resolve(JSON.parse(String(event.data)) as SnapshotMessage);
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("Snapshot parsing failed."),
          );
        }
      },
      { once: true },
    );
  });
}

function nextMessages<T>(socket: WebSocket, count: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const messages: T[] = [];
    const listener = (event: MessageEvent) => {
      try {
        messages.push(JSON.parse(String(event.data)) as T);
        if (messages.length === count) {
          socket.removeEventListener("message", listener);
          resolve(messages);
        }
      } catch (error) {
        socket.removeEventListener("message", listener);
        reject(
          error instanceof Error
            ? error
            : new Error("Table message parsing failed."),
        );
      }
    };
    socket.addEventListener("message", listener);
  });
}

describe("public table WebSocket boundary", () => {
  it("reuses mock identity, ignores browser table IDs, and resyncs after eviction", async () => {
    const first = await exports.default.fetch(
      new Request(`${origin}/api/auth/mock`, {
        body: JSON.stringify({ displayName: "東 Player" }),
        headers: { "Content-Type": "application/json", Origin: origin },
        method: "POST",
      }),
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json<{
      readonly actor: { readonly id: string };
      readonly tableId: string;
    }>();
    const cookie = first.headers.get("Set-Cookie");
    expect(cookie).not.toBeNull();

    const refreshed = await exports.default.fetch(
      new Request(`${origin}/api/auth/mock`, {
        body: JSON.stringify({ displayName: "東 Player" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie ?? "",
          Origin: origin,
        },
        method: "POST",
      }),
    );
    expect(refreshed.status).toBe(201);
    const session = await refreshed.json<AuthenticatedSession>();
    expect(session).toMatchObject({
      access: "member",
      actor: { id: firstBody.actor.id },
      role: "owner",
      tableId: firstBody.tableId,
    });
    const refreshedCookie = refreshed.headers.get("Set-Cookie");
    expect(refreshedCookie).not.toBeNull();
    expect(session.tableId).toMatch(/^[A-Za-z0-9_-]{22}$/u);

    const upgradeResponse = await exports.default.fetch(
      new Request(`${origin}/api/table/socket?tableId=browser-chosen-decoy`, {
        headers: {
          Cookie: refreshedCookie ?? "",
          Origin: origin,
          Upgrade: "websocket",
        },
      }),
    );
    expect(upgradeResponse.status).toBe(101);
    const socket = upgradeResponse.webSocket;
    expect(socket).not.toBeNull();
    if (socket === null)
      throw new Error("WebSocket upgrade returned no socket.");

    const initialMessage = nextMessage(socket);
    socket.accept();
    const initial = await initialMessage;
    expect(initial).toMatchObject({
      protocolVersion: 1,
      stateVersion: 0,
      type: "table/snapshot",
      view: {
        phase: "lobby",
        tableId: session.tableId,
        viewer: {
          actor: { displayName: "東 Player" },
          role: "spectator",
        },
      },
    });

    const commandMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      socket,
      2,
    );
    socket.send(
      JSON.stringify({
        type: "table/command",
        protocolVersion: 1,
        commandId: "public-owner-east",
        expectedStateVersion: 0,
        command: { type: "lobby/claim-seat", seat: "east" },
      }),
    );
    const [claimReceipt, claimedSnapshot] = await commandMessages;
    expect(claimReceipt).toMatchObject({
      type: "table/receipt",
      commandId: "public-owner-east",
      outcome: "applied",
      stateVersion: 1,
    });
    if (claimedSnapshot?.type !== "table/snapshot") {
      throw new Error("Expected the claimed table snapshot.");
    }
    expect(claimedSnapshot).toMatchObject({
      type: "table/snapshot",
      stateVersion: 1,
      view: {
        viewer: { role: "player", seat: "east" },
      },
    });
    expect(claimedSnapshot.view.seats).toContainEqual({
      occupant: { displayName: "東 Player", id: session.actor.id },
      ready: false,
      seat: "east",
    });

    const room = env.TABLE_ROOM.getByName(session.tableId);
    await evictDurableObject(room);
    const resyncMessage = nextMessage(socket);
    socket.send(
      JSON.stringify({
        lastSeenStateVersion: 1,
        protocolVersion: 1,
        type: "table/resync",
      }),
    );
    expect(await resyncMessage).toEqual(claimedSnapshot);
    socket.close(1000, "test complete");

    const candidateResponse = await exports.default.fetch(
      new Request(`${origin}/api/auth/mock`, {
        body: JSON.stringify({ displayName: "Join Candidate" }),
        headers: { "Content-Type": "application/json", Origin: origin },
        method: "POST",
      }),
    );
    expect(candidateResponse.status).toBe(201);
    const candidate = await candidateResponse.json<AuthenticatedSession>();
    expect(candidate).toMatchObject({
      access: "join-required",
      actor: { displayName: "Join Candidate" },
      authenticated: true,
      tableId: session.tableId,
    });
    expect(candidate.role).toBeUndefined();
    expect(candidate.actor.id).not.toBe(session.actor.id);
    const candidateCookie = candidateResponse.headers.get("Set-Cookie");
    expect(candidateCookie).not.toBeNull();

    const candidateDenied = await exports.default.fetch(
      new Request(`${origin}/api/table/socket`, {
        headers: {
          Cookie: candidateCookie ?? "",
          Origin: origin,
          Upgrade: "websocket",
        },
      }),
    );
    expect(candidateDenied.status).toBe(403);
    await candidateDenied.body?.cancel();

    const invitationResponse = await exports.default.fetch(
      new Request(`${origin}/api/table/invitations`, {
        body: JSON.stringify({ invitedActorId: candidate.actor.id }),
        headers: {
          "Content-Type": "application/json",
          Cookie: refreshedCookie ?? "",
          Origin: origin,
          "X-CSRF-Token": session.csrfToken,
        },
        method: "POST",
      }),
    );
    expect(invitationResponse.status).toBe(200);
    const invitation = await invitationResponse.json<{
      readonly capability: string;
    }>();
    expect(invitation.capability).toMatch(
      new RegExp(`^v1\\.${session.tableId}\\.`),
    );

    const redemptionResponse = await exports.default.fetch(
      new Request(`${origin}/api/table/invitations/redeem`, {
        body: JSON.stringify({ capability: invitation.capability }),
        headers: {
          "Content-Type": "application/json",
          Cookie: candidateCookie ?? "",
          Origin: origin,
          "X-CSRF-Token": candidate.csrfToken,
        },
        method: "POST",
      }),
    );
    expect(redemptionResponse.status).toBe(200);
    await redemptionResponse.body?.cancel();

    const joinedResponse = await exports.default.fetch(
      new Request(`${origin}/api/session`, {
        headers: { Cookie: candidateCookie ?? "" },
      }),
    );
    expect(joinedResponse.status).toBe(200);
    await expect(joinedResponse.json()).resolves.toMatchObject({
      access: "member",
      actor: { id: candidate.actor.id },
      authenticated: true,
      role: "member",
      tableId: session.tableId,
    });

    const candidateUpgrade = await exports.default.fetch(
      new Request(`${origin}/api/table/socket`, {
        headers: {
          Cookie: candidateCookie ?? "",
          Origin: origin,
          Upgrade: "websocket",
        },
      }),
    );
    expect(candidateUpgrade.status).toBe(101);
    const candidateSocket = candidateUpgrade.webSocket;
    expect(candidateSocket).not.toBeNull();
    if (candidateSocket === null)
      throw new Error("Candidate WebSocket upgrade returned no socket.");
    const candidateInitialMessage = nextMessage(candidateSocket);
    candidateSocket.accept();
    await expect(candidateInitialMessage).resolves.toMatchObject({
      view: {
        tableId: session.tableId,
        viewer: { actor: candidate.actor },
      },
    });
    candidateSocket.close(1000, "test complete");

    const logoutCandidateResponse = await exports.default.fetch(
      new Request(`${origin}/api/auth/mock`, {
        body: JSON.stringify({ displayName: "Logout Candidate" }),
        headers: { "Content-Type": "application/json", Origin: origin },
        method: "POST",
      }),
    );
    expect(logoutCandidateResponse.status).toBe(201);
    const logoutCandidate =
      await logoutCandidateResponse.json<AuthenticatedSession>();
    expect(logoutCandidate).toMatchObject({
      access: "join-required",
      actor: { displayName: "Logout Candidate" },
      authenticated: true,
      tableId: session.tableId,
    });
    expect(logoutCandidate.role).toBeUndefined();
    expect(logoutCandidate.actor.id).not.toBe(candidate.actor.id);
    const logoutCandidateCookie =
      logoutCandidateResponse.headers.get("Set-Cookie");
    expect(logoutCandidateCookie).not.toBeNull();

    const logoutResponse = await exports.default.fetch(
      new Request(`${origin}/api/session/logout`, {
        body: JSON.stringify({}),
        headers: {
          "Content-Type": "application/json",
          Cookie: logoutCandidateCookie ?? "",
          Origin: origin,
          "X-CSRF-Token": logoutCandidate.csrfToken,
        },
        method: "POST",
      }),
    );
    expect(logoutResponse.status).toBe(204);
    const clearedCookie = logoutResponse.headers.get("Set-Cookie");
    expect(clearedCookie).toContain(`${env.SESSION_COOKIE_NAME}=;`);
    expect(clearedCookie).toContain("Max-Age=0");

    const loggedOutSession = await exports.default.fetch(
      new Request(`${origin}/api/session`, {
        headers: { Cookie: logoutCandidateCookie ?? "" },
      }),
    );
    expect(loggedOutSession.status).toBe(200);
    await expect(loggedOutSession.json()).resolves.toEqual({
      authenticated: false,
      mode: "mock",
    });
  });
});
