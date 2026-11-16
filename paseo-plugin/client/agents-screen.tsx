// The Multitasker screen and its sidebar row: the one entry to the queue's cards and the agents they come
// from. Agents come from the plugin's `manager.agents` RPC and cards from the queue's list. While the
// screen is shown, Paseo's agent directory subscription refetches the agents on every agent update (at
// most every 1.5 s), with a slow poll behind it; without the subscription the screen polls every 4 s.
// The sidebar row counts the agents that need the user from the same two lists, polled slowly. Archive
// goes through the Paseo API, one call per listed agent; Mark done through the plugin RPC.
import { usePaseo, useRpc, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Loading, SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { cardNodeId, needsYouCount } from "../shared/agent-tree";
import { listAgents, markAgentDone, replyToAgent } from "../shared/rpc";
import { AgentsView, type ManagerView } from "./agents-view";
import { QUEUE_QUERY_KEY, useCardMutations, useClosedCards, useQueueList, useTick } from "./queue-client";

export const AGENTS_SCREEN_ID = "agents";
/** The inbox's screen before the Multitasker screen replaced it: links and open tabs that still name it land on Multitasker. */
export const QUEUE_SCREEN_ID = "queue";
const AGENTS_QUERY_KEY = ["agent-queue", "manager", "agents"] as const;
const POLL_MS = 4_000;
const LIVE_POLL_MS = 30_000;
const SIDEBAR_POLL_MS = 15_000;
const THROTTLE_MS = 1_500;

/** The agent list; the screen and the sidebar row share one query, each with its own poll. */
function useAgentList(refetchInterval: number) {
  const list = useRpc(listAgents);
  return useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: async () => ({ ...(await list({})), fetchedAt: Date.now() }),
    refetchInterval,
    refetchOnWindowFocus: true,
  });
}

/**
 * The chosen view, folds and selection, for the life of the client: module scope, so they outlive the
 * screen. Not persisted: Paseo 0.15.3 gives a plugin screen no storage on the device.
 */
const FOLDS = new Map<string, boolean>();
const memory: { view: ManagerView; agent: string | null } = { view: "tree", agent: null };

/**
 * Paseo's agent directory as a trigger: calls `onChange` when any agent changes (throttled), and after a
 * reconnect. Returns whether the subscription is live.
 */
function useAgentDirectory(onChange: () => void): boolean {
  const paseo = usePaseo();
  const [live, setLive] = useState(false);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    const controller = new AbortController();
    let release: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    let snapshots = 0;
    const fire = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        latest.current();
      }, Math.max(0, last + THROTTLE_MS - Date.now()));
    };
    paseo.agents
      .list({ subscribe: {}, signal: controller.signal })
      .then(({ subscription }) => {
        if (controller.signal.aborted) {
          void subscription.release();
          return;
        }
        const off = subscription.subscribe({
          // the first snapshot is the list just fetched; a later one follows a reconnect
          snapshot: () => {
            snapshots += 1;
            setLive(true);
            if (snapshots > 1) fire();
          },
          update: (message) => {
            if (message.type === "agent_update") fire();
          },
          error: () => setLive(false),
        });
        release = () => {
          off();
          void subscription.release();
        };
      })
      .catch(() => {
        if (!controller.signal.aborted) setLive(false);
      });
    return () => {
      controller.abort();
      release?.();
      if (timer) clearTimeout(timer);
    };
  }, [paseo]);
  return live;
}

/**
 * Opened with params (a link): `agent` selects that agent; `card` opens that card in full, with its
 * agent selected.
 */
export function AgentsScreen({ theme, layout, navigation, params }: PluginScreenProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const paseo = usePaseo();
  const markDone = useRpc(markAgentDone);
  const replyTo = useRpc(replyToAgent);
  const refresh = () => queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
  const live = useAgentDirectory(() => {
    void refresh();
    void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
  });
  const agents = useAgentList(live ? LIVE_POLL_MS : POLL_MS);
  const queue = useQueueList();
  const [view, setView] = useState<ManagerView>(memory.view);
  const [agentId, setAgentId] = useState<string | null>(memory.agent);
  const [cardId, setCardId] = useState<string | null>(null);
  const cards = useCardMutations({ navigation, onClosed: () => setCardId(null), onChanged: () => void refresh(), origin: { compact: layout.compact, view } });
  useTick(15_000);

  // A link's agent, or the agent of its card once the cards are in.
  const linkedCard = params?.card ? queue.data?.cards.find((card) => card.id === params.card) : undefined;
  const linkedAgent = params?.agent ?? (linkedCard ? cardNodeId(linkedCard) : null);
  useEffect(() => {
    if (linkedAgent) {
      memory.agent = linkedAgent;
      setAgentId(linkedAgent);
    }
    if (params?.card) setCardId(params.card);
  }, [linkedAgent, params?.card]);

  const mark = useMutation({
    mutationFn: (id: string) => markDone({ agentId: id }),
    onSuccess: () => refresh(),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const reply = async (id: string, text: string) => {
    try {
      await replyTo({ agentId: id, text });
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const markMany = async (ids: string[]) => {
    let marked = 0;
    for (const id of ids) {
      try {
        await markDone({ agentId: id });
        marked += 1;
      } catch (error) {
        toast.error(`Marked ${marked}; ${ids.length - marked} left: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    await refresh();
  };

  const archive = async (ids: string[]) => {
    let archived = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await paseo.agents.ref(id).archive();
        archived += 1;
      } catch (error) {
        failed.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failed.length) toast.error(`Archived ${archived}; ${failed.length} failed: ${failed[0]}`);
    else toast.show(archived === 1 ? "Archived 1 agent" : `Archived ${archived} agents`);
    await refresh();
  };

  // A poll that fails after a snapshot is in keeps that snapshot and says Offline in the header until a
  // poll succeeds. Only a screen with nothing to show says what failed.
  const failure = agents.error ?? queue.error;
  if (failure && (!agents.data || !queue.data)) {
    return (
      <View style={{ flex: 1, padding: layout.compact ? 16 : 32, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 14 }}>{failure.message}</Text>
      </View>
    );
  }
  if (!agents.data || !queue.data) return <Loading />;

  const { fetchedAt, ...agentData } = agents.data;
  const { fetchedAt: _queueFetchedAt, ...queueData } = queue.data;
  const openAgent = navigation?.openAgent;
  return (
    <AgentsView
      theme={theme}
      compact={layout.compact}
      agents={agentData}
      queue={queueData}
      clockSkewMs={Date.now() - fetchedAt}
      offline={Boolean(failure)}
      view={view}
      onView={(next) => {
        memory.view = next;
        setView(next);
      }}
      selectedAgent={agentId}
      onSelectAgent={(id) => {
        memory.agent = id;
        setAgentId(id);
      }}
      selectedCard={cardId}
      onSelectCard={setCardId}
      folds={FOLDS}
      cards={cards}
      onMarkDone={(id) => mark.mutate(id)}
      onReply={reply}
      marking={mark.isPending ? mark.variables ?? null : null}
      onMarkDoneMany={markMany}
      onArchive={archive}
      onOpenAgent={openAgent ? (id) => openAgent({ agentId: id }) : null}
      useClosed={useClosedCards}
    />
  );
}

/**
 * The sidebar row: `Multitasker n`, n the agents that need the user (muted at 0), archived ones with open
 * cards included. Until the agent list is in, each session with open cards counts once.
 */
export function AgentsSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const agents = useAgentList(SIDEBAR_POLL_MS);
  const queue = useQueueList();
  const count = useMemo(
    () =>
      queue.data
        ? needsYouCount({ agents: agents.data?.agents ?? [], cards: queue.data.cards, marks: agents.data?.marks ?? {}, home: queue.data.home })
        : 0,
    [agents.data, queue.data],
  );
  const screen = currentScreen?.screenId;
  return (
    <SidebarRow
      icon="Bot"
      label="Multitasker"
      active={screen === AGENTS_SCREEN_ID || screen === QUEUE_SCREEN_ID}
      onPress={() => openScreen({ screenId: AGENTS_SCREEN_ID })}
      trailing={
        <Text
          style={{
            color: count ? theme.colors.foreground : theme.colors.foregroundMuted,
            fontSize: 13,
            fontWeight: count ? "600" : "400",
            fontVariant: ["tabular-nums"],
          }}
        >
          {count}
        </Text>
      }
    />
  );
}
