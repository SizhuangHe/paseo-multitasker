Multitasker adds a **Multitasker** screen to Paseo for what your agent sessions need from you next. Agents file cards; each card holds one thing: a decision only you can make, a result to look at, or dispatched work that came back. Permission requests and failed turns also become cards without the agent doing anything. Its sidebar row, Multitasker, shows how many agents are waiting on you, counting both Needs you and Idle agents.

## The screen

Every non-archived agent appears as Needs you, Idle, Working or Done, nested under the agent that started it and grouped by workspace. View it as a connected tree, three columns by state, or a list. An open card sits under the agent that filed it and opens with three steps: what you asked, what the session did, what now waits for you. Closed cards stay in a Closed list under their agent, and Reopen puts one back. The screen also works on a phone-width viewport.

On a card:

- **Send** sends the option you picked, plus any reply you type, into the session as your message. The agent's recommended option starts selected.
- **Discuss** opens the session and asks it to explain the card and wait.
- **Dismiss** closes the card and tells the session not to wait for an answer. **Seen** closes a result or returned work without a message.
- **Later** moves the card to the end of the list.
- A permission request shows Paseo's own choices; a click answers it in the session.
- **Mark done** and a reply box are available for an Idle agent that filed nothing.

Keys: `j`/`k` step through cards, `1`-`9` pick an option, `Enter` sends, `e` marks seen, `o` opens the session, `Esc` goes back.

## How agents file cards

Every interactive session gets a local MCP server with three tools:

- `queue_add` files one card, or updates a card the agent filed before.
- `queue_track` registers dispatched work; when that `paseo run` child finishes, its result comes back as a card.
- `queue_resolve` closes the agent's own cards once handled.

The plugin passes the session its MCP address and the environment variable `AGENT_QUEUE_SESSION`, so the plugin, not the agent, decides which session a card belongs to. The server also sends a short filing guide as its instructions. Sessions that were already open get the tools when Paseo next reopens them.

## Data

- **Stored locally**: one SQLite file, `~/.local/share/agent-queue/queue.db`. `AGENT_QUEUE_DB` in the daemon's environment moves it. It holds cards (what agents wrote in them), dispatch tracks, closed cards with how you closed them, Mark done marks, and a log of when an agent was seen idle. For each session with a card it also keeps the title, working folder, workspace, provider, model and parent session. Failed turns store the error message. Permission requests store the tool's command or paths (up to 2000 characters). A finished child's card stores the last paragraph of its reply. The file is not encrypted.
- **Read from Paseo**: the agent list, agent timelines (to tell a waiting agent from a finished one), and the provider list (to show provider and model names).
- **Sent into sessions**: Send, Discuss and Dismiss write a message into the card's session, handed to a running turn without interrupting it. Those messages, and everything agents put into the queue tools and read back from them, go to each session's agent provider like the rest of the conversation. Messages are written in Chinese when the card's own text has Chinese characters, English otherwise.
- **Permissions**: the plugin answers a permission request only when you click a choice on its card. It never approves on its own.
- **Result previews**: a result card can name a file. When such a card renders, the plugin reads that file and sends it to the client so a phone can show it. It reads only files under your home directory with a text extension (md, txt, json, jsonl, csv, tsv, log, yaml, yml, toml, py, ts, js, tex, bib) or an image (png, jpg, jpeg, gif, webp), up to 2 MB, and shows the first 80 lines, each cut at 400 characters. It skips hidden files and folders, and any path with a part that looks like a secret (`.env`, secret, credential, token, password, `api-key`, `service-account`, `id_rsa`, `id_ed25519`, or a `.pem`, `.key`, `.p12`, `.pfx` or `.kdbx` file). Because the path comes from what an agent wrote on the card, a card can make the plugin load any file that passes those rules.
- **Network**: the plugin makes no outbound requests of its own. Its MCP server listens only on 127.0.0.1, on a random port, and each session has its own address and token.

## Requirements

- Paseo 0.15.3 or later, with plugins turned on (Settings, Plugins, Enable plugins).
- Node.js 22.13 or later on the daemon host (23.4 or later on Node 23), for the built-in `node:sqlite` module.
- npm on the daemon's command path for the install step. It links the card store from the same repository and adds no packages from the npm registry.
- Tested on macOS.

## Limits

- Fold state lasts while the app is open and is not saved.
- There are no notifications beyond the sidebar count.
- Work Paseo cannot see, such as an agent's in-process subagents, shows up only if the agent files it.
- Card fields have length limits sized for a phone screen.
- Each daemon host has its own database; nothing syncs between machines.
