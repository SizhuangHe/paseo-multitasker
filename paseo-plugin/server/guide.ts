// The agent guide, served as the MCP server's `instructions`: when to file a card and how to write it.
// The tool descriptions in tools.ts carry the schema; this carries the judgment.
export const GUIDE = `# Agent queue

The user runs many sessions and agents at once, and work comes back while they are elsewhere. The queue is the one place they look: they go through cards one at a time and can jump from a card back to the session it came from. Tools: queue_add, queue_track, queue_resolve.

## When to file

File a card when the next step is the user's:
- a decision only they can make (an approval, a trade-off, which direction to take);
- a result they should look at (a document, a comparison, a PR, a report);
- dispatched work that came back, after you have checked it;
- a concrete question you leave to the user and wait on to go further. This counts even while the user is chatting with you: file it, and resolve it in the turn where they answer.

Do not file what you can decide yourself, a plain turn handoff with no concrete question, progress reports, or "done" with nothing for the user to do. Test: if the user did not look at this session for a week, would they miss something that was theirs to do? If so, file it.

## One card, one thing

- A card holds exactly one ask, one result or one receipt. Several things means several queue_add calls.
- Every card has a topic (this session's name, the same on all its cards) and a timeline of three steps about this one thing: You asked (when, as M/D, and what the user asked for that led here), It did (how far you got), Blocked (what the card waits on from the user).
- Filing again with the same ask short, result label or receipt title while that card is open updates it in place.
- To swap an open card for another (a re-worded question, a question that was superseded), file the new one with replaces: <old card id>. The old card closes and the new one takes its place.
- If the session needs the user again later, file a new card. If it follows a past decision, say in timeline.asked what the user decided and when.
- Few open cards beat many: decide what you can, and file only what needs the user.

## Writing a card

Write in the language you use with the user, facts only, for someone who has forgotten this work: they may open the card days later.
- Say plainly what the thing is. Card text (topic, timeline, short, option labels, look, line) avoids jargon and names you made up in the conversation (experiment, run or branch names, codes, bare PR numbers). Exact names go in the full text (question, effect) with a short explanation next to them.
- No dangling pronouns ("it", "those", "the above"); a short line must stand alone and name the project and the thing.
- Each ask says all three: what is to be decided in which project (short, question), why now (whyNow), and what each option does (options[].effect).
- Make every ask answerable on its own. List options as action buttons ("Redo from the live data, then swap"), not one-word labels. Give recommended (the index of your pick) when you have one, so the user only nods; leave it out when it is truly the user's call.
- With no options to list, the user replies in the session or on the card.
- A card does not replace replying in the session. Report in the session as usual; the card is the entry point and summary.
- After filing, say so in your reply ("Filed in the queue: …"; "Updated the card in the queue" for an update).

Widths: short fields are limited by display width, where CJK and full-width characters count 1 and other characters count 0.5. Limits: topic 15, timeline texts 18 (stuck 20), ask short 30, option label 12, option effect 40, whyNow 60, result look 22, receipt line 26; ask question up to 400 characters, receipt conclusion up to 3 sentences. The tool reports the actual width when a field is over.

## Dispatching work

Call queue_track when you dispatch work (a child agent or subagent). With a childRef (the Paseo agent id) the result is filed as a card automatically when the child finishes. Otherwise, when the work is back and you have checked it, file a receipt with queue_add: its trackId, a conclusion (up to 3 sentences) and a one-line line. File failures too (status: failed) so a track does not stay open.

## When the user answers

An answer from the queue arrives in your session as a user message: the card's question with the chosen option, then the user's own reply if any. The card is already closed, so do not resolve it; act on the answer. A message saying the user skipped a question means: do not wait, continue on your own judgment, and ask again separately only if you truly cannot go on. A message saying the user wants to talk a card over means: explain the background in a few plain sentences (with each option's trade-offs for an ask), then wait.

## Resolve as soon as handled

Resolve your own cards in the same turn they are handled; do not wait for the user to come back and clear them. Use queue_resolve with cards: [ids] (queue_add returns the new id and lists your open cards), or all: true. A card is handled when the user answered in the session, saw the result, you did what they decided, or it no longer needs them. Do not file again what you already resolved. Before ending a turn, check your open cards and resolve the handled ones.
`;
