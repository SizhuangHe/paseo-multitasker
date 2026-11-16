import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AGENTS_SCREEN_ID, AgentsScreen, AgentsSidebarItem, QUEUE_SCREEN_ID } from "./client/agents-screen";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: AGENTS_SCREEN_ID, title: "Multitasker", Component: AgentsScreen }),
    // The inbox's screen id, kept so links and open tabs that still name it land on the same screen.
    client.addScreen({ id: QUEUE_SCREEN_ID, title: "Multitasker", Component: AgentsScreen }),
    client.addSidebarHeaderItem({ id: AGENTS_SCREEN_ID, title: "Multitasker", Component: AgentsSidebarItem }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
