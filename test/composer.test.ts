import { describe, expect, test } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { modelEntriesFromWire, withRecent, type ModelEntry } from "../core/models.ts";
import { ComposerBar } from "../app/src/chat/ChatInput.tsx";
import { Conversation } from "../app/src/chat/Conversation.tsx";
import { ModelChoices, ModelPill, modelLine, modelLists, modelName, pickerKey, returnsFocus } from "../app/src/chat/ModelPicker.tsx";
import { resolve } from "../app/src/shell/keymap.ts";

/**
 * The one message box (phone and desktop, 2026-09-24): the text on top and a row inside the same field —
 * "+", the model pill (name, then effort), the mic where dictation works, send. The pill opens "Select
 * model": a short list with a check on the current one, then Effort › and More models ›.
 */

const MODELS: ModelEntry[] = [
  { id: "opus-low", handle: "anthropic/claude-opus-5-5", label: "Opus 5.5", description: "For complex work", isFeatured: true, reasoningEffort: "low" },
  { id: "opus-medium", handle: "anthropic/claude-opus-5-5", label: "Opus 5.5", description: "For complex work", isFeatured: true, reasoningEffort: "medium" },
  { id: "opus-high", handle: "anthropic/claude-opus-5-5", label: "Opus 5.5", description: "For complex work", isFeatured: true, reasoningEffort: "high" },
  { id: "sonnet", handle: "anthropic/claude-sonnet-5", label: "Sonnet 5", isFeatured: true },
  { id: "gpt", handle: "openai/gpt-6", label: "GPT-6" },
  { id: "llama", handle: "ollama/llama-5", label: "ollama/llama-5" },
];
const CURRENT = "anthropic/claude-opus-5-5";

/** Every element in a rendered-to-elements tree (props.children followed), for finding a handler without a DOM. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}
const choice = (tree: ReactNode, id: string) => elements(tree).find((e) => e.props["data-choice"] === id);
/** The accessible names of the buttons in the box's bottom row, in order. */
const barLabels = (html: string) => {
  const bar = html.slice(html.indexOf('class="loki-composer-bar'));
  return [...bar.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
};

const conversation = (touch: boolean, draft = "") =>
  renderToStaticMarkup(
    createElement(Conversation, {
      touch,
      view: { rows: [], status: "idle", model: CURRENT, reasoningEffort: "medium" },
      actions: { onSend: () => {}, onPickModel: async () => {} },
      models: MODELS,
      draft: { value: { text: draft, images: [] }, onChange: () => {} },
    }),
  );

describe("the message box's bottom row", () => {
  for (const touch of [false, true]) {
    test(`${touch ? "phone" : "desktop"}: +, the model pill with its name and effort, then send, inside the one field`, () => {
      const html = conversation(touch);
      expect(barLabels(html)).toEqual(["Attach files", "Model: Opus 5.5, medium effort", "Send"]);
      // the text and the row share the one rounded field
      expect(html.indexOf('class="loki-composer-box')).toBeLessThan(html.indexOf("loki-composer-text"));
      expect(html.indexOf("loki-composer-text")).toBeLessThan(html.indexOf('class="loki-composer-bar'));
      // the model in the foreground, the effort after it in the muted colour
      expect(html).toMatch(/class="loki-model-pill-name">Opus 5\.5<\/span><span class="loki-model-pill-effort">Medium<\/span>/);
      // the old placement is gone: no model or effort chip in the row under the box
      expect(html).not.toContain('aria-label="model"');
      expect(html).not.toContain("reasoning effort:");
    });
  }

  for (const touch of [false, true]) {
    test(`${touch ? "phone" : "desktop"}: the permission mode sits beside the model pill, inside the box, not in the row under it`, () => {
      const html = renderToStaticMarkup(
        createElement(Conversation, {
          touch,
          view: { rows: [], status: "idle", model: CURRENT, reasoningEffort: "medium", mode: "standard" },
          actions: { onSend: () => {}, onPickModel: async () => {}, onPickMode: async () => {} },
          models: MODELS,
          draft: { value: { text: "", images: [] }, onChange: () => {} },
        }),
      );
      expect(barLabels(html)).toEqual(["Attach files", "Model: Opus 5.5, medium effort", "permission mode", "Send"]);
      expect(html).not.toContain("loki-conversation-footer");
    });
  }

  test("the mic sits between the pill and send, only where dictation works", () => {
    const bar = (dictation: boolean) =>
      barLabels(renderToStaticMarkup(createElement(ComposerBar, { touch: false, attach: { onClick: () => {} }, tools: null, dictation: dictation ? { listening: false, pending: false, title: "dictate", onToggle: () => {} } : null, canSend: false, sendLabel: "Send", onSend: () => {} })));
    expect(bar(true)).toEqual(["Attach files", "Dictate", "Send"]);
    expect(bar(false)).toEqual(["Attach files", "Send"]);
  });

  test("send is disabled while the box is empty and live once there is text", () => {
    const send = (html: string) => html.match(/<button[^>]*aria-label="Send"[^>]*>/)![0];
    expect(send(conversation(false))).toContain('disabled=""');
    expect(send(conversation(false, "ship it"))).not.toContain("disabled");
    expect(send(conversation(true, "ship it"))).not.toContain("disabled");
  });

  test("while the agent works, an empty box's send is Stop; typing brings send back (it queues); no handler, no Stop", () => {
    const working = (text: string, onStop?: () => Promise<string | null>) =>
      barLabels(
        renderToStaticMarkup(
          createElement(Conversation, {
            view: { rows: [], status: "streaming" },
            actions: { onSend: () => {}, ...(onStop ? { onStop } : {}) },
            draft: { value: { text, images: [] }, onChange: () => {} },
          }),
        ),
      );
    const stop = async () => null;
    expect(working("", stop)).toEqual(["Attach files", "Stop"]);
    expect(working("and also this", stop)).toEqual(["Attach files", "Queue: sends when this turn ends"]);
    expect(working("")).toEqual(["Attach files", "Queue: sends when this turn ends"]);
    // idle: never Stop
    const idle = renderToStaticMarkup(createElement(Conversation, { view: { rows: [], status: "idle" }, actions: { onSend: () => {}, onStop: stop } }));
    expect(barLabels(idle)).toEqual(["Attach files", "Send"]);
  });

  test("without a model handler there is no pill", () => {
    const html = renderToStaticMarkup(createElement(Conversation, { view: { rows: [], status: "idle" }, actions: { onSend: () => {} } }));
    expect(barLabels(html)).toEqual(["Attach files", "Send"]);
  });
});

describe("the model pill", () => {
  test("names the model, then the effort; a tap opens the picker", () => {
    let opened = 0;
    const pill = ModelPill({ name: "Opus 5.5", effort: "medium", open: false, onClick: () => opened++ });
    const html = renderToStaticMarkup(pill);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    (elements(pill).find((e) => typeof e.props.onClick === "function")!.props.onClick as () => void)();
    expect(opened).toBe(1);
  });
  test("the name is the preset's label, else the handle's short form; unknown reads Model", () => {
    expect(modelName(MODELS, CURRENT)).toBe("Opus 5.5");
    expect(modelName(MODELS, "openrouter/some-model")).toBe("some-model");
    expect(modelName(MODELS, null)).toBe("Model");
  });
});

describe("select model", () => {
  const props = { entries: MODELS, current: CURRENT, currentEffort: "medium" as const, loading: false, query: "", touch: false, onView: () => {}, onQuery: () => {}, onPick: () => {}, onClose: () => {} };

  test("the short list is the featured models (and the current one); the rest are More models", () => {
    const { short, more } = modelLists(MODELS, CURRENT);
    expect(short.map((g) => g.handle)).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5"]);
    expect(more.map((g) => g.handle)).toEqual(["ollama/llama-5", "openai/gpt-6"]);
    // a current model outside the featured set still shows, so its check is in view
    expect(modelLists(MODELS, "openai/gpt-6").short.map((g) => g.handle)).toContain("openai/gpt-6");
    // nothing featured: the first few
    const plain = MODELS.map(({ isFeatured: _f, ...e }) => e);
    expect(modelLists(plain, null).short.length).toBeGreaterThan(0);
  });

  test("quick picks lead with the models used lately, then featured ones up to five, only ones the account can reach", () => {
    const many: ModelEntry[] = [
      ...MODELS,
      { id: "f1", handle: "letta/f1", label: "F1", isFeatured: true },
      { id: "f2", handle: "letta/f2", label: "F2", isFeatured: true },
      { id: "f3", handle: "letta/f3", label: "F3", isFeatured: true },
      { id: "gated", handle: "letta/gated", label: "Gated", isFeatured: true, available: false },
    ];
    // gpt and llama were used lately (gpt the latest); the featured ones fill the rest, the unreachable one never
    const used = withRecent(many, ["openai/gpt-6", "ollama/llama-5"]);
    expect(modelLists(used, null).short.map((g) => g.handle)).toEqual(["openai/gpt-6", "ollama/llama-5", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5", "letta/f1"]);
    // the unreachable model is still in More models, where the filter finds it
    expect(modelLists(used, null).more.map((g) => g.handle)).toContain("letta/gated");
    // an unreachable recent model is left out of the quick picks too
    const gatedRecent = withRecent(many, ["letta/gated", "openai/gpt-6"]);
    expect(modelLists(gatedRecent, null).short[0].handle).toBe("openai/gpt-6");
    // the current model outside the picks is added after them, so its check is in view
    expect(modelLists(used, "letta/f3").short.map((g) => g.handle).at(-1)).toBe("letta/f3");
    // nothing recent or featured: the first few the account can reach
    const plain = many.map(({ isFeatured: _f, ...e }) => e);
    expect(modelLists(plain, null).short.map((g) => g.handle)).not.toContain("letta/gated");
  });

  test("list_models' available_handles marks the rest unreachable; null or absent marks none", () => {
    const wire = [{ id: "a", handle: "anthropic/a", label: "A" }, { id: "b", handle: "letta/b", label: "B" }];
    expect(modelEntriesFromWire(wire, ["anthropic/a"]).map((e) => e.available)).toEqual([undefined, false]);
    expect(modelEntriesFromWire(wire, null).some((e) => e.available === false)).toBe(false);
    expect(modelEntriesFromWire(wire).some((e) => e.available === false)).toBe(false);
  });

  test("each row's line is the model's own description, else its handle; never invented", () => {
    const { short, more } = modelLists(MODELS, CURRENT);
    expect(modelLine(short[0])).toBe("For complex work");
    expect(modelLine(short[1])).toBe("anthropic/claude-sonnet-5");
    expect(modelLine(more.find((g) => g.handle === "ollama/llama-5")!)).toBeNull(); // the label already is the handle
  });

  test("the list shows the short list with a check on the current model, then Effort › and More models ›", () => {
    const html = renderToStaticMarkup(ModelChoices({ ...props, view: "models" }));
    expect(html).toContain(">Select model<");
    const names = [...html.matchAll(/class="loki-model-name">([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual(["Opus 5.5", "Sonnet 5"]);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-checked="true"[^>]*data-choice="anthropic\/claude-opus-5-5"/);
    expect(html).toContain(">Effort<");
    expect(html).toContain(">More models<");
  });

  test("Effort › opens that model's efforts; choosing one picks it", () => {
    const views: string[] = [];
    const picked: unknown[] = [];
    (choice(ModelChoices({ ...props, view: "models", onView: (v) => views.push(v) }), "effort")!.props.onClick as () => void)();
    expect(views).toEqual(["effort"]);
    const tree = ModelChoices({ ...props, view: "effort", onPick: (s) => picked.push(s) });
    const html = renderToStaticMarkup(tree);
    expect([...html.matchAll(/class="loki-model-name">([^<]+)</g)].map((m) => m[1])).toEqual(["Low", "Medium", "High"]);
    expect(html).toMatch(/aria-checked="true"[^>]*data-choice="medium"/);
    (choice(tree, "high")!.props.onClick as () => void)();
    expect(picked).toEqual([{ id: "opus-high", handle: CURRENT, reasoningEffort: "high" }]);
  });

  test("More models › lists the rest", () => {
    const views: string[] = [];
    (choice(ModelChoices({ ...props, view: "models", onView: (v) => views.push(v) }), "more")!.props.onClick as () => void)();
    expect(views).toEqual(["more"]);
    const html = renderToStaticMarkup(ModelChoices({ ...props, view: "more" }));
    const names = [...html.matchAll(/class="loki-model-name">([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual(["ollama/llama-5", "GPT-6"]);
  });

  test("the phone's sheet has a grip and a round close at the top left; the popover has neither", () => {
    const closed: number[] = [];
    const phone = ModelChoices({ ...props, view: "models", touch: true, onClose: () => closed.push(1) });
    const html = renderToStaticMarkup(phone);
    expect(html).toContain("loki-model-grip");
    expect(html.indexOf('aria-label="Close"')).toBeLessThan(html.indexOf(">Select model<"));
    (elements(phone).find((e) => e.props.label === "Close")!.props.onClick as () => void)();
    expect(closed).toEqual([1]);
    const desk = renderToStaticMarkup(ModelChoices({ ...props, view: "models" }));
    expect(desk).not.toContain("loki-model-grip");
    expect(desk).not.toContain('aria-label="Close"');
  });
});

describe("the picker's keys and focus", () => {
  test("arrows, Home and End move; Esc closes", () => {
    expect(pickerKey("ArrowDown", 0, 3)).toEqual({ focus: 1 });
    expect(pickerKey("ArrowDown", 2, 3)).toEqual({ focus: 2 });
    expect(pickerKey("ArrowUp", 0, 3)).toEqual({ focus: 0 });
    expect(pickerKey("End", 0, 3)).toEqual({ focus: 2 });
    expect(pickerKey("Home", 2, 3)).toEqual({ focus: 0 });
    expect(pickerKey("Escape", 1, 3)).toEqual({ close: true });
    expect(pickerKey("a", 1, 3)).toBeNull();
  });
  test("closing hands focus back to the pill when it was in the picker (or dropped), not when you clicked elsewhere", () => {
    const body = {};
    const inside = {};
    const picker = { contains: (n: unknown) => n === inside };
    expect(returnsFocus(inside, picker, body)).toBe(true);
    expect(returnsFocus(body, picker, body)).toBe(true);
    expect(returnsFocus(null, picker, body)).toBe(true);
    expect(returnsFocus({}, picker, body)).toBe(false);
  });
  test("⌘⇧M (chat.model) still opens it, from the box too", () => {
    const ev = { key: "m", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, target: { tagName: "TEXTAREA" } } as unknown as KeyboardEvent;
    expect(resolve(ev, "desk")?.id).toBe("chat.model");
  });
});
