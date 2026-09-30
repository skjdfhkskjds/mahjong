import { useEffect, useState } from "react";

import type {
  TableCommand,
  TableReceipt,
  ViewerSafeTableSnapshot,
} from "../../adapters/transport/table-socket-status.js";
import type { GamePanelProps } from "./game-display.js";
import {
  mapGameDisplay,
  reactionActionId,
  reactionSubmissionPending,
  type GameMappingInput,
  type PendingReactionSubmission,
} from "./game-mapper.js";
import { GamePanel } from "./game-panel.js";

export interface GameControllerProps {
  readonly connected: boolean;
  readonly latestReceipt: TableReceipt | undefined;
  readonly onCommand: (command: TableCommand) => boolean;
  readonly snapshot: ViewerSafeTableSnapshot;
}

export function createGamePanelProps(
  input: GameMappingInput & Pick<GameControllerProps, "onCommand">,
  onReactionSent: (pending: PendingReactionSubmission) => void,
): GamePanelProps {
  const game = mapGameDisplay(input);
  const self = input.snapshot.view.game?.viewerActions?.self ?? [];
  const reaction = input.snapshot.view.game?.viewerActions?.reaction;
  return {
    game,
    onDraw: () => {
      if (game?.draw && !game.draw.disabled)
        input.onCommand({ type: "game/draw" });
    },
    onDiscard: (tileId) => {
      if (
        game?.hand?.some((tile) => tile.id === tileId && !tile.discardDisabled)
      )
        input.onCommand({ type: "game/discard", tileId });
    },
    onReact: (actionId) => {
      if (
        game?.reaction?.status !== "open" ||
        !game.reaction.actions.some(
          (action) => action.id === actionId && !action.disabled,
        )
      )
        return;
      const response = reaction?.actions.find(
        (action) => reactionActionId(action) === actionId,
      );
      if (
        reaction &&
        response &&
        input.onCommand({
          type: "game/react",
          windowId: reaction.windowId,
          response,
        })
      ) {
        onReactionSent({
          receiptAtSubmission: input.latestReceipt,
          snapshotAtSubmission: input.snapshot,
          windowId: reaction.windowId,
        });
      }
    },
    onConcealedKong: (actionId) => {
      if (
        !game?.concealedKongs.some(
          (action) => action.id === actionId && !action.disabled,
        )
      )
        return;
      const command = self.find(
        (action) =>
          action.type === "game/declare-concealed-kong" &&
          action.tileIds.join(":") === actionId,
      );
      if (command) input.onCommand(command);
    },
    onAddedKong: (actionId) => {
      if (
        !game?.addedKongs.some(
          (action) => action.id === actionId && !action.disabled,
        )
      )
        return;
      const command = self.find(
        (action) =>
          action.type === "game/propose-added-kong" &&
          `${action.meldId}:${String(action.tileId)}` === actionId,
      );
      if (command) input.onCommand(command);
    },
    onWin: () => {
      if (game?.win && !game.win.disabled)
        input.onCommand({ type: "game/declare-win" });
    },
  };
}

// Expiry is a local presentation gate; only the server resolves a deadline.
export function deadlineRefreshDelay(
  deadlineAt: number | null,
  now: number,
  renderedAt = now,
): number | null {
  if (deadlineAt === null) return null;
  // A render just before expiry still needs one refresh if the effect runs late.
  if (now >= deadlineAt) return renderedAt < deadlineAt ? 0 : null;
  return Math.min(deadlineAt - now, 1_000);
}

export function GameController(input: GameControllerProps) {
  const [pendingReaction, setPendingReaction] =
    useState<PendingReactionSubmission>();
  const [, refresh] = useState(0);
  const now = Date.now();
  const deadlineAt = input.snapshot.view.game?.deadlineAt ?? null;
  const windowId = input.snapshot.view.game?.viewerActions?.reaction?.windowId;
  useEffect(() => {
    setPendingReaction((pending) =>
      reactionSubmissionPending(pending, {
        connected: input.connected,
        latestReceipt: input.latestReceipt,
        snapshot: input.snapshot,
        windowId,
      })
        ? pending
        : undefined,
    );
  }, [input.connected, input.latestReceipt, input.snapshot, windowId]);
  useEffect(() => {
    const delay = deadlineRefreshDelay(deadlineAt, Date.now(), now);
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      refresh((value) => value + 1);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [deadlineAt, now]);
  const props = createGamePanelProps(
    { ...input, pendingReaction, now },
    setPendingReaction,
  );
  return <GamePanel {...props} />;
}
