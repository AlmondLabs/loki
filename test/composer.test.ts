import { describe, expect, test } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withRecent, type Harness, type ModelEntry } from "../core/models.ts";
import { ComposerBar } from "../app/src/chat/chat-input.tsx";
import { Conversation } from "../app/src/chat/conversation.tsx";
import { ModelChoices, ModelPill, modelLine, modelLists, modelName, nameInHarness, pickerKey, returnsFocus } from "../app/src/chat/model-picker.tsx";
import { groupModelEntries } from "../app/src/chat/model-picker.tsx";
import { resolve } from "../app/src/shell/keymap.ts";
import { must } from "./fixtures/must.ts";

/**
 * The one message box (phone and desktop, 2026-09-24): the text on top and a row inside the same field —
 * "+", the model pill (name, then effort), the mic where dictation works, send. The pill opens "Select
 * model": the harnesses as tabs, the chosen one's models with a check on the current one, More models ›, then the
 * current model's effort levels (plan 021).
 */

const MODELS: ModelEntry[] = [
  { id: "opus-low", handle: "anthropic/claude-opus-5-5", label: "Opus 5.5", description: "For complex work", is_featured: true, reasoning_effort: "low" },
  { id: "opus-medium", handle: "anthropic/claude-opus-5-5", label: "Opus 5.5", description: "For complex work", is_featured: true, reasoning_effort: "medium" },
  { id: "opus-high", handle: "anthropic/claude-opus-5-5", label: "Opus 5.5", description: "For complex work", is_featured: true, reasoning_effort: "high" },
  { id: "sonnet", handle: "anthropic/claude-sonnet-5", label: "Sonnet 5", is_featured: true },
  { id: "gpt", handle: "openai/gpt-6", label: "GPT-6" },
  { id: "llama", handle: "ollama/llama-5", label: "ollama/llama-5" },
];
const CURRENT = "anthropic/claude-opus-5-5";

/** Every element in a rendered-to-elements tree (props.children followed), for finding a handler without a DOM. */
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
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
      barLabels(
        renderToStaticMarkup(
          createElement(ComposerBar, {
            touch: false,
            attach: { onClick: () => {} },
            tools: null,
            dictation: dictation ? { listening: false, pending: false, title: "dictate", onToggle: () => {} } : null,
            canSend: false,
            sendLabel: "Send",
            onSend: () => {},
          }),
        ),
      );
    expect(bar(true)).toEqual(["Attach files", "Dictate", "Send"]);
    expect(bar(false)).toEqual(["Attach files", "Send"]);
  });

  test("send is disabled while the box is empty and live once there is text", () => {
    const send = (html: string) => must(/<button[^>]*aria-label="Send"[^>]*>/.exec(html), "the Send button")[0];
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
    const stop = () => Promise.resolve(null);
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
    (
      must(
        elements(pill).find((e) => typeof e.props.onClick === "function"),
        "the pill's button",
      ).props.onClick as () => void
    )();
    expect(opened).toBe(1);
  });
  test("the name is the preset's label, else the handle's short form; unknown reads Model", () => {
    expect(modelName(MODELS, CURRENT)).toBe("Opus 5.5");
    expect(modelName(MODELS, "openrouter/some-model")).toBe("some-model");
    expect(modelName(MODELS, null)).toBe("Model");
  });
});

describe("select model", () => {
  const props = {
    entries: MODELS,
    current: CURRENT,
    currentEffort: "medium" as const,
    loading: false,
    query: "",
    touch: false,
    onView: () => {},
    onQuery: () => {},
    onPick: () => {},
    onClose: () => {},
  };

  test("the short list is the featured models (and the current one); the rest are More models", () => {
    const { short, more } = modelLists(MODELS, CURRENT);
    expect(short.map((g) => g.handle)).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5"]);
    expect(more.map((g) => g.handle)).toEqual(["ollama/llama-5", "openai/gpt-6"]);
    // a current model outside the featured set still shows, so its check is in view
    expect(modelLists(MODELS, "openai/gpt-6").short.map((g) => g.handle)).toContain("openai/gpt-6");
    // nothing featured: the first few
    const plain = MODELS.map(({ is_featured: _f, ...e }) => e);
    expect(modelLists(plain, null).short.length).toBeGreaterThan(0);
  });

  test("quick picks lead with the models used lately, then featured ones up to five, only ones the account can reach", () => {
    const many: ModelEntry[] = [
      ...MODELS,
      { id: "f1", handle: "lab/f1", label: "F1", is_featured: true },
      { id: "f2", handle: "lab/f2", label: "F2", is_featured: true },
      { id: "f3", handle: "lab/f3", label: "F3", is_featured: true },
      { id: "gated", handle: "lab/gated", label: "Gated", is_featured: true, available: false },
    ];
    // gpt and llama were used lately (gpt the latest); the featured ones fill the rest, the unreachable one never
    const used = withRecent(many, ["openai/gpt-6", "ollama/llama-5"]);
    expect(modelLists(used, null).short.map((g) => g.handle)).toEqual([
      "openai/gpt-6",
      "ollama/llama-5",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5",
      "lab/f1",
    ]);
    // the unreachable model is still in More models, where the filter finds it
    expect(modelLists(used, null).more.map((g) => g.handle)).toContain("lab/gated");
    // an unreachable recent model is left out of the quick picks too
    const gatedRecent = withRecent(many, ["lab/gated", "openai/gpt-6"]);
    expect(modelLists(gatedRecent, null).short[0].handle).toBe("openai/gpt-6");
    // the current model outside the picks is added after them, so its check is in view
    expect(
      modelLists(used, "lab/f3")
        .short.map((g) => g.handle)
        .at(-1),
    ).toBe("lab/f3");
    // nothing recent or featured: the first few the account can reach
    const plain = many.map(({ is_featured: _f, ...e }) => e);
    expect(modelLists(plain, null).short.map((g) => g.handle)).not.toContain("lab/gated");
  });

  test("each row's line is the model's own description, else its handle; never invented", () => {
    const { short, more } = modelLists(MODELS, CURRENT);
    expect(modelLine(short[0])).toBe("For complex work");
    expect(modelLine(short[1])).toBe("anthropic/claude-sonnet-5");
    expect(
      modelLine(
        must(
          more.find((g) => g.handle === "ollama/llama-5"),
          "the ollama/llama-5 entry",
        ),
      ),
    ).toBeNull(); // the label already is the handle
  });

  test("the list shows the short list with a check on the current model, More models ›, then its efforts", () => {
    const html = renderToStaticMarkup(ModelChoices({ ...props, view: "models" }));
    expect(html).toContain(">Select model<");
    const names = [...html.matchAll(/class="loki-model-name">([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual(["Opus 5.5", "Sonnet 5"]);
    expect(html).toMatch(/aria-checked="true"[^>]*data-choice="anthropic\/claude-opus-5-5"/);
    expect(html).toContain(">More models<");
    // loki alone: no tabs
    expect(html).not.toContain('role="tablist"');
    expect(html.indexOf(">More models<")).toBeLessThan(html.indexOf('role="radiogroup"'));
  });

  test("the efforts are a row under the list; choosing one picks it at once", () => {
    const picked: unknown[] = [];
    const tree = ModelChoices({ ...props, view: "models", onPick: (s) => picked.push(s) });
    const html = renderToStaticMarkup(tree);
    const row = html.slice(html.indexOf('role="radiogroup"'));
    expect(row).toContain('aria-label="Effort"');
    expect([...row.matchAll(/role="radio"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Low", "Medium", "High"]);
    expect(row).toMatch(/role="radio" aria-checked="true" data-choice="medium"/);
    (must(choice(tree, "high"), "the high choice").props.onClick as () => void)();
    expect(picked).toEqual([{ id: "opus-high", handle: CURRENT, reasoning_effort: "high" }]);
    // a model with one level or none has no row
    expect(renderToStaticMarkup(ModelChoices({ ...props, current: "anthropic/claude-sonnet-5", view: "models" }))).not.toContain('role="radiogroup"');
  });

  test("More models › lists the rest", () => {
    const views: string[] = [];
    (must(choice(ModelChoices({ ...props, view: "models", onView: (v) => views.push(v) }), "more"), "the more choice").props.onClick as () => void)();
    expect(views).toEqual(["more"]);
    const html = renderToStaticMarkup(ModelChoices({ ...props, view: "more" }));
    const names = [...html.matchAll(/class="loki-model-name">([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual(["ollama/llama-5", "GPT-6"]);
  });

  const ACP: ModelEntry[] = [
    ...MODELS,
    {
      id: "acp:claude-code/default",
      handle: "acp:claude-code/default",
      label: "Claude Code",
      description: "runs on Claude Code, signed in as you",
      is_featured: true,
    },
    { id: "acp:claude-code/sonnet@low", handle: "acp:claude-code/sonnet", label: "Claude Code · Sonnet", reasoning_effort: "low" },
    { id: "acp:claude-code/sonnet@max", handle: "acp:claude-code/sonnet", label: "Claude Code · Sonnet", reasoning_effort: "max" },
    { id: "acp:codex/default", handle: "acp:codex/default", label: "Codex", is_featured: true },
  ];
  const tabsOf = (html: string) =>
    [...html.matchAll(/role="tab" aria-selected="(true|false)"(?: aria-disabled="true")?[^>]*data-harness="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [
      m[2],
      m[3],
      m[1] === "true",
      m[0].includes("aria-disabled"),
    ]);

  test("the harnesses are tabs, loki first; it opens on the chat's own, showing only that harness's models", () => {
    const html = renderToStaticMarkup(ModelChoices({ ...props, entries: ACP, view: "models" }));
    expect(tabsOf(html)).toEqual([
      ["loki", "loki", true, false],
      ["claude-code", "Claude Code", false, false],
      ["codex", "Codex", false, false],
    ]);
    expect([...html.matchAll(/class="loki-model-name">([^<]+)</g)].map((m) => m[1])).toEqual(["Opus 5.5", "Sonnet 5"]);
    const claude = renderToStaticMarkup(ModelChoices({ ...props, entries: ACP, current: "acp:claude-code/sonnet", currentEffort: "max", view: "models" }));
    expect(tabsOf(claude).find((t) => t[2])?.[0]).toBe("claude-code");
    // in its own tab an agent's models drop its name; its default reads Default
    expect([...claude.matchAll(/class="loki-model-name">([^<]+)</g)].map((m) => m[1])).toEqual(["Default", "Sonnet"]);
    expect(claude).not.toContain(">More models<");
    expect([...claude.matchAll(/role="radio"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Low", "Max"]);
  });

  test("choosing a tab shows it without moving the chat; picking one of its models moves it, at the effort chosen", () => {
    const harnesses: Array<string | null> = [];
    const picked: unknown[] = [];
    const tree = ModelChoices({ ...props, entries: ACP, view: "models", onHarness: (h) => harnesses.push(h), onPick: (s) => picked.push(s) });
    (
      must(
        elements(tree).find((e) => e.props["data-harness"] === "claude-code"),
        "the Claude Code tab",
      ).props.onClick as () => void
    )();
    expect(harnesses).toEqual(["claude-code"]);
    expect(picked).toEqual([]);
    const shown = ModelChoices({ ...props, entries: ACP, harness: "claude-code", view: "models", onPick: (s) => picked.push(s) });
    const html = renderToStaticMarkup(shown);
    // the chat's model is not in this tab: no check, and no effort row until a model here is the chat's
    expect(html).not.toMatch(/aria-checked="true"/);
    expect(html).not.toContain('role="radiogroup"');
    (must(choice(shown, "acp:claude-code/default"), "Claude Code's default").props.onClick as () => void)();
    expect(picked).toEqual([{ id: "acp:claude-code/default", handle: "acp:claude-code/default" }]);
  });

  test("once the chat has started, the other harnesses are locked and say why", () => {
    const harnesses: Array<string | null> = [];
    const tree = ModelChoices({ ...props, entries: ACP, started: true, view: "models", onHarness: (h) => harnesses.push(h) });
    const html = renderToStaticMarkup(tree);
    expect(tabsOf(html).map((t) => [t[0], t[3]])).toEqual([
      ["loki", false],
      ["claude-code", true],
      ["codex", true],
    ]);
    expect(html).toContain('title="fixed once the chat has started; start a new chat to change"');
    (
      must(
        elements(tree).find((e) => e.props["data-harness"] === "codex"),
        "the Codex tab",
      ).props.onClick as () => void
    )();
    expect(harnesses).toEqual([]);
  });

  test("a model's name in its harness's tab", () => {
    const groups = groupModelEntries(ACP);
    const claude: Harness = { id: "claude-code", name: "Claude Code", locked: false };
    const named = (handle: string, h = claude) =>
      nameInHarness(
        must(
          groups.find((g) => g.handle === handle),
          handle,
        ),
        h,
      );
    expect(named("acp:claude-code/default")).toBe("Default");
    expect(named("acp:claude-code/sonnet")).toBe("Sonnet");
    expect(named(CURRENT, { id: null, name: "loki", locked: false })).toBe("Opus 5.5");
    // the pill keeps the agent's name: KD3
    expect(modelName(ACP, "acp:claude-code/sonnet")).toBe("Claude Code · Sonnet");
    expect(modelName(ACP, CURRENT)).toBe("Opus 5.5");
  });

  test("the phone's sheet has a grip and a round close at the top left; the popover has neither", () => {
    const closed: number[] = [];
    const phone = ModelChoices({ ...props, view: "models", touch: true, onClose: () => closed.push(1) });
    const html = renderToStaticMarkup(phone);
    expect(html).toContain("loki-model-grip");
    expect(html.indexOf('aria-label="Close"')).toBeLessThan(html.indexOf(">Select model<"));
    (
      must(
        elements(phone).find((e) => e.props.label === "Close"),
        "the Close button",
      ).props.onClick as () => void
    )();
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
