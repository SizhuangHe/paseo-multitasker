import { homedir } from "node:os";
import type { PaseoApi } from "./server/host.ts";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Queue, QueueInputError } from "agent-queue-core";
import { AgentFeed } from "./server/agents";
import { answerCard, discussCard, dismissCard, replyToAgent as sendAgentReply } from "./server/answer";
import { onPermissionAfter, onPermissionBefore, onTurnAfter } from "./server/hooks";
import { QueueMcpServer } from "./server/mcp";
import { answerPermission as answerPermissionRequest } from "./server/permissions";
import { readPreview } from "./server/preview";
import { TitleCache } from "./server/session";
import { createQueueTools } from "./server/tools";
import { trackParents } from "./shared/agent-line";
import {
  answerPermission,
  listAgents,
  listClosed,
  listQueue,
  markAgentDone,
  replyToAgent,
  markCardDone,
  reopenCard,
  previewResult,
  sendAnswers,
  snoozeCard,
  startDiscussion,
} from "./shared/rpc";

const MCP_SERVER_NAME = "agent-queue";

export default function contribute(server: PluginServerContext) {
  let queue: Queue | null = null;
  const getQueue = () => (queue ??= new Queue());
  let paseo: PaseoApi | null = null;
  const mcp = new QueueMcpServer(createQueueTools(getQueue), () => paseo);
  const mcpReady = mcp.start();
  const titles = new TitleCache();
  const agentFeed = new AgentFeed();

  const removers = [
    // The queue tools reach every interactive session as a plugin-owned MCP server.
    server.addHook("agent.open.before", async ({ request }, context) => {
      paseo ??= context.paseo;
      if (request.purpose !== "interactive") return;
      await mcpReady;
      const endpoint = mcp.endpointFor(request.agentId);
      return {
        ...request,
        mcpServers: {
          ...request.mcpServers,
          [MCP_SERVER_NAME]: { type: "http", url: endpoint.url, headers: endpoint.headers, alwaysLoad: true },
        },
        env: { ...request.env, AGENT_QUEUE_SESSION: `paseo:${request.agentId}` },
      };
    }),
    server.addHook("agent.turn.after", (event, context) => {
      paseo ??= context.paseo;
      return onTurnAfter(getQueue(), event, context.paseo);
    }),
    server.addHook("agent.permission.before", (event, context) => onPermissionBefore(getQueue(), event, context.paseo)),
    server.addHook("agent.permission.after", (event) => onPermissionAfter(getQueue(), event)),
  ];

  server.handle(listQueue, async (_input, context) => {
    paseo ??= context.paseo;
    const store = getQueue();
    const cards = store.list();
    const childOf = trackParents(cards, store.listTracks({ state: "all" }));
    const known = new Map(cards.map((card) => [card.sessionId, card.sessionTitle]));
    const sessionTitles: Record<string, string> = {};
    const parents = cards
      .filter((card) => card.host === "paseo")
      .map((card) => card.agent?.parentSessionId ?? childOf[card.sessionId] ?? null);
    for (const id of parents) {
      if (!id || id in sessionTitles) continue;
      // A parent's name is the topic its agent filed under last, else the host's title for it.
      const title = store.sessionTopic({ host: "paseo", sessionId: id }) ?? known.get(id) ?? (await titles.get(context.paseo, id));
      if (title) sessionTitles[id] = title;
    }
    return { now: new Date().toISOString(), cards, sessionTitles, childOf, home: homedir() };
  });
  server.handle(listClosed, ({ host, sessionId, limit }) => getQueue().closedCards({ host, sessionId }, limit));
  server.handle(previewResult, ({ cardId, resultId }) => {
    const card = getQueue().get(cardId);
    return readPreview(card?.results.find((r) => r.id === resultId)?.href);
  });
  server.handle(snoozeCard, ({ cardId }) => ({ card: getQueue().snooze(cardId) }));
  // "steer" hands a busy session a message inside its running turn instead of interrupting it.
  const sender = (paseoApi: PaseoApi) => (sessionId: string, text: string) =>
    paseoApi.agents.ref(sessionId).send(text, { activeTurnBehavior: "steer" });
  const plainErrors = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof QueueInputError) throw new Error(error.issues.join("; "));
      throw error;
    }
  };
  server.handle(markCardDone, ({ cardId, origin }, context) => {
    paseo ??= context.paseo;
    return plainErrors(async () => ({ card: await dismissCard({ queue: getQueue(), send: sender(context.paseo) }, cardId, origin) }));
  });
  server.handle(replyToAgent, ({ agentId, text }, context) => {
    paseo ??= context.paseo;
    return plainErrors(async () => {
      await sendAgentReply({ send: sender(context.paseo) }, agentId, text);
      return {};
    });
  });
  server.handle(reopenCard, ({ cardId }) => plainErrors(async () => ({ card: getQueue().reopen(cardId) })));
  server.handle(sendAnswers, ({ cardId, picks, reply, origin }, context) => {
    paseo ??= context.paseo;
    return plainErrors(async () => ({
      card: await answerCard({ queue: getQueue(), send: sender(context.paseo) }, cardId, picks, reply ?? "", origin),
    }));
  });
  const discussing = new Map<string, Promise<unknown>>();
  server.handle(startDiscussion, ({ cardId }, context) => {
    paseo ??= context.paseo;
    return plainErrors(() => discussCard({ queue: getQueue(), send: sender(context.paseo), pending: discussing }, cardId));
  });
  server.handle(answerPermission, ({ cardId, askId, answer, origin }, context) => {
    paseo ??= context.paseo;
    const deps = {
      queue: getQueue(),
      pending: async (sessionId: string) => {
        const refreshed = await context.paseo.agents.ref(sessionId).refresh();
        return refreshed ? (refreshed.agent.pendingPermissions ?? []) : null;
      },
      respond: (sessionId: string, requestId: string, response: AgentPermissionResponse) =>
        context.paseo.agents.ref(sessionId).respondToPermission({ requestId, response }),
    };
    return answerPermissionRequest(deps, cardId, askId, answer, origin);
  });

  // The agent manager: every non-archived agent (and archived ones with open cards) with the facts its
  // state rules need, and Mark done.
  server.handle(listAgents, (_input, context) => {
    paseo ??= context.paseo;
    const store = getQueue();
    const carded = new Set(store.list().filter((card) => card.host === "paseo").map((card) => card.sessionId));
    return agentFeed.list({ paseo: context.paseo, carded, marks: store.doneMarks("paseo"), log: store });
  });
  server.handle(markAgentDone, ({ agentId }) => ({ markedAt: getQueue().markDone({ host: "paseo", sessionId: agentId }).markedAt }));

  return async () => {
    for (const remove of removers) remove();
    await mcp.stop();
    queue?.close();
    queue = null;
  };
}
