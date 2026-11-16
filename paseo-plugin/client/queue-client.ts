// The queue's data and the card actions, for the Agents screen and its sidebar row: the polled card
// list, and Send, Seen, Dismiss, Later, Discuss, permission answers, opening a session, a link or a path,
// through the plugin RPCs. The screen and the row share one query, so an action shows on both.
import { openExternalUrl, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { discussable, type Picks } from "../shared/cards";
import { clientCopyDeps, copyWithFallback } from "../shared/clipboard";
import {
  answerPermission,
  listClosed,
  listQueue,
  markCardDone,
  previewResult,
  reopenCard,
  sendAnswers,
  snoozeCard,
  startDiscussion,
  type ClosedCards,
  type PermissionAnswer,
  type QueueAsk,
  type QueueCard,
} from "../shared/rpc";
import { isOpenableUrl } from "./format";
import type { PermissionState, QueueViewProps } from "./queue-view";

export const QUEUE_QUERY_KEY = ["agent-queue", "list"] as const;
const POLL_MS = 5_000;

export function useQueueList() {
  const list = useRpc(listQueue);
  return useQuery({
    queryKey: QUEUE_QUERY_KEY,
    queryFn: async () => ({ ...(await list({})), fetchedAt: Date.now() }),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });
}

/**
 * A session's closed cards while its detail shows. The key sits under the list's, so every card action
 * that refreshes the list refreshes these too.
 */
export function useClosedCards(host: QueueCard["host"], sessionId: string, limit?: number): ClosedCards | undefined {
  const closed = useRpc(listClosed);
  return useQuery({
    queryKey: [...QUEUE_QUERY_KEY, "closed", host, sessionId, limit ?? null],
    queryFn: () => closed({ host, sessionId, limit }),
    refetchInterval: POLL_MS,
  }).data;
}

/** Re-renders every `ms` so times move between polls. */
export function useTick(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

/** The card callbacks the card components take. */
export type CardCallbacks = Pick<
  QueueViewProps,
  "onOpenSession" | "onDiscuss" | "onSnooze" | "onDone" | "onAnswer" | "onPermission" | "permissionStates" | "onOpenUrl" | "onPreview" | "onCopyPath" | "busyCardId"
> & {
  /** Seen on each of these cards, one after the other; settles when all went through. Absent where the screen has none. */
  onSeenMany?(cards: QueueCard[]): Promise<void>;
  /** Puts a card closed by Seen back to open. */
  onReopen?(card: QueueCard): Promise<void>;
};

export function useCardMutations(options: {
  navigation: PluginScreenProps["navigation"];
  /** The open card closed (sent, seen, dismissed) or was put off: leave its detail. */
  onClosed(): void;
  /** Any action went through: refresh what else depends on the cards. */
  onChanged?(): void;
  /** The phone layout and the view the screen is in, recorded on the cards the user closes. */
  origin?: { compact: boolean; view: "tree" | "columns" | "list" };
}): CardCallbacks {
  const queryClient = useQueryClient();
  const toast = useToast();
  const snooze = useRpc(snoozeCard);
  const done = useRpc(markCardDone);
  const reopen = useRpc(reopenCard);
  const answer = useRpc(sendAnswers);
  const respond = useRpc(answerPermission);
  const startDiscuss = useRpc(startDiscussion);
  const preview = useRpc(previewResult);
  const [permissionStates, setPermissionStates] = useState<Record<string, PermissionState>>({});
  const changed = () => {
    options.onChanged?.();
    return queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
  };
  const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error));

  const settle = useMutation({
    mutationFn: async ({ card, kind }: { card: QueueCard; kind: "snooze" | "done" }) =>
      kind === "snooze" ? snooze({ cardId: card.id }) : done({ cardId: card.id, ...(options.origin ? { origin: options.origin } : {}) }),
    onSuccess: ({ card }, { kind }) => {
      // A dismissed card with a permission still pending stays open, showing just that request.
      if (kind === "snooze" || card.state !== "open") options.onClosed();
      return changed();
    },
    onError: fail,
  });

  // Seen on a batch goes through the same call as a single Seen; each card can be reopened.
  const seenMany = async (batch: QueueCard[]) => {
    try {
      for (const card of batch) await done({ cardId: card.id, origin: { ...options.origin, batch: true } });
    } catch (error) {
      fail(error);
    } finally {
      await changed();
    }
  };
  const reopenOne = async (card: QueueCard) => {
    try {
      await reopen({ cardId: card.id });
    } catch (error) {
      fail(error);
    } finally {
      await changed();
    }
  };

  const send = useMutation({
    mutationFn: ({ card, picks, reply }: { card: QueueCard; picks: Picks; reply: string }) =>
      answer({ cardId: card.id, picks, ...(reply.trim() ? { reply } : {}), ...(options.origin ? { origin: options.origin } : {}) }),
    onSuccess: ({ card }) => {
      toast.show("Sent");
      if (card.state !== "open") options.onClosed();
      return changed();
    },
    onError: fail,
  });

  // A permission answer goes out at once; its row shows busy, then how it went (or the error as a toast).
  const setPermission = (key: string, state: PermissionState | null) =>
    setPermissionStates((all) => {
      const next = { ...all };
      if (state) next[key] = state;
      else delete next[key];
      return next;
    });
  const permission = useMutation({
    mutationFn: ({ card, ask, answer: choice }: { card: QueueCard; ask: QueueAsk; answer: PermissionAnswer }) =>
      respond({ cardId: card.id, askId: ask.id, answer: choice, ...(options.origin ? { origin: options.origin } : {}) }),
    onMutate: ({ card, ask }) => setPermission(`${card.id}/${ask.id}`, "busy"),
    onSuccess: ({ outcome }, { card, ask }) => {
      setPermission(`${card.id}/${ask.id}`, outcome);
      return changed();
    },
    onError: (error, { card, ask }) => {
      setPermission(`${card.id}/${ask.id}`, null);
      fail(error);
    },
  });

  const openAgent = options.navigation?.openAgent;
  const onOpenSession = (card: QueueCard) => openAgent?.({ agentId: card.sessionId });

  // Discuss: the session opens at once while one message asks it to talk the card over; the card shows
  // Discussing once the message went. Paseo answers a send only after the session has started its turn,
  // which can take seconds (tens of seconds for a session it must load first), so the session does not
  // wait on it. If the message fails, the error shows and the card stays untagged.
  const discuss = useMutation({
    mutationFn: ({ card }: { card: QueueCard }) => startDiscuss({ cardId: card.id }),
    onMutate: ({ card }) => {
      openAgent?.({ agentId: card.sessionId });
    },
    onSuccess: () => changed(),
    onError: fail,
  });

  return {
    onOpenSession: openAgent ? onOpenSession : null,
    onDiscuss: (card) => {
      if (discussable(card)) discuss.mutate({ card });
    },
    onSeenMany: seenMany,
    onReopen: reopenOne,
    onSnooze: (card) => settle.mutate({ card, kind: "snooze" }),
    onDone: (card) => settle.mutate({ card, kind: "done" }),
    onAnswer: (card, picks, reply) => send.mutate({ card, picks, reply }),
    onPermission: (card, ask, choice) => permission.mutate({ card, ask, answer: choice }),
    permissionStates,
    onOpenUrl: (url) => {
      if (!isOpenableUrl(url)) return;
      void openExternalUrl(url).catch((error: unknown) => toast.error(String(error)));
    },
    onPreview: (card, resultId) => preview({ cardId: card.id, resultId }),
    // Over plain http the clipboard API is missing: copy through a hidden textarea instead, and when
    // that fails too the card shows the path to select by hand (no error toast).
    onCopyPath: async (path) => {
      const copied = await copyWithFallback(path, clientCopyDeps(copyText));
      if (copied) toast.show("Path copied");
      return copied;
    },
    busyCardId: settle.isPending
      ? settle.variables?.card.id ?? null
      : send.isPending
      ? send.variables?.card.id ?? null
      : discuss.isPending
      ? discuss.variables?.card.id ?? null
      : null,
  };
}
