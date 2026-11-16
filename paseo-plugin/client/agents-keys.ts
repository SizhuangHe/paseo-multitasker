// The Agents screen's keyboard: one `keydown` listener on the document while the screen is mounted,
// desktop only. What a key means is shared/agent-keys; this only reads the focus and hands the action over.
import { useEffect, useRef } from "react";
import { isChoiceChipOf, keyAction, type KeyAction, type KeyContext } from "../shared/agent-keys";

// The plugin compiles without the DOM lib (it also runs on native, where there is no `document`).
interface DomKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  repeat: boolean;
  target: { tagName?: string; isContentEditable?: boolean; id?: string; getAttribute?(name: string): string | null } | null;
  preventDefault(): void;
  stopPropagation(): void;
}
interface DomDocument {
  addEventListener(type: "keydown", listener: (event: DomKeyEvent) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (event: DomKeyEvent) => void, capture: boolean): void;
}

const isTyping = (target: DomKeyEvent["target"]): boolean =>
  target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable === true;

const CONTROL_ROLES = new Set(["button", "link", "checkbox", "tab"]);
/** A focused control acts on Enter itself (RN-web Pressables are `div role="button"`), and its handler runs before ours. */
const isControl = (target: DomKeyEvent["target"]): boolean =>
  target?.tagName === "BUTTON" || target?.tagName === "A" || CONTROL_ROLES.has(target?.getAttribute?.("role") ?? "");

export function useAgentKeys(options: { enabled: boolean; context: Omit<KeyContext, "typing" | "control" | "choice">; openCardId: string | null; onAction(action: KeyAction): void }) {
  const latest = useRef(options);
  latest.current = options;
  const { enabled } = options;
  useEffect(() => {
    const doc = (globalThis as { document?: DomDocument }).document;
    if (!enabled || !doc) return;
    const listener = (event: DomKeyEvent) => {
      const action = keyAction(
        { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, repeat: event.repeat },
        { ...latest.current.context, typing: isTyping(event.target), control: isControl(event.target), choice: isChoiceChipOf(event.target?.id, latest.current.openCardId) },
      );
      if (!action) return;
      // A focused Pressable stops Enter before it reaches the document, so this listens in the capture phase and keeps the key from also pressing what has focus.
      event.preventDefault();
      event.stopPropagation();
      latest.current.onAction(action);
    };
    doc.addEventListener("keydown", listener, true);
    return () => doc.removeEventListener("keydown", listener, true);
  }, [enabled]);
}

/** A ref for the element that shows the selection: when it becomes selected it scrolls into view if it is off screen (j/k can leave the screen). */
export function useScrollIntoView(selected: boolean) {
  const ref = useRef<{ scrollIntoView?: (options: { block: "nearest" }) => void } | null>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return ref as never;
}
