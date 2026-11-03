import { HeroCanvas } from "./hero-canvas";
import { InboxDemo } from "./inbox-demo";
import { LearnDemo } from "./learn-demo";
import { PhoneDemo } from "./phone-demo";
import { SuggestionsDemo } from "./suggestions-demo";

/** Where people get loki: the newest release, Homebrew, the source. */
const RELEASES = "https://github.com/AlmondLabs/loki/releases/latest";
const SOURCE = "https://github.com/AlmondLabs/loki";
const BREW = "brew install --cask almondlabs/loki/loki";

/** What loki is besides its demos, each in a line or two. */
const FACTS = [
  {
    title: "Any model provider",
    text: "Your own key for Anthropic, OpenAI, Google, OpenRouter or Ollama, or a sign-in through the browser. The key stays in your system's keychain, and you pay the provider directly.",
  },
  {
    title: "Memory you can read",
    text: "Each agent's memory is a folder of files kept in git: a tree you can browse, and what it learned as a timeline of commits.",
  },
  {
    title: "On your own computer",
    text: "loki runs your agents in its own daemon on your machine. Chats, canvases and cards are files in your home folder.",
  },
  {
    title: "Open source",
    text: "Apache-2.0 and built in the open on GitHub. Read the code, report what you find, send a change.",
  },
];

/** loki's website: the hero with a live canvas, then a live demo per part of the app, then what it is built on (plan 066). */
export function Site() {
  return (
    <div className="site">
      <header className="site-nav">
        <a className="site-brand" href="#top">
          <img src="icon.svg" alt="" width={24} height={24} />
          loki
        </a>
        <nav aria-label="sections">
          <a href="#canvas">canvas</a>
          <a href="#inbox">inbox</a>
          <a href="#suggestions">suggestions</a>
          <a href="#phone">phone</a>
          <a href="#learn">learn</a>
          <a href={SOURCE}>GitHub</a>
        </nav>
        <a className="site-button site-button-small" href={RELEASES}>
          download
        </a>
      </header>

      <main id="top">
        <section className="site-hero" id="canvas">
          <div className="site-hero-text">
            <p className="site-eyebrow">for the AI agents you run on your own Mac</p>
            <h1>A memory palace your agent builds.</h1>
            <p className="site-lede">
              Agents talk in text. loki gives yours a canvas: ask for a plan, a checklist, a chart or a slider, and the agent writes a small file that a second
              later is a live widget you can drag, tick and slide. What you did rides along on your next message, so the agent sees the canvas the way you left
              it.
            </p>
            <div className="site-actions">
              <a className="site-button" href={RELEASES}>
                download for macOS
              </a>
              <a className="site-link" href={SOURCE}>
                source on GitHub →
              </a>
            </div>
            <Install />
            <p className="site-fine">Free and open source under Apache-2.0. Windows and Linux in preview.</p>
          </div>
          <HeroCanvas />
        </section>

        <section className="site-section" id="inbox">
          <div className="site-section-text">
            <h2>One inbox for everything waiting on you</h2>
            <p>
              Run five chats at once and the work comes back in five places. The Inbox puts it in one: a card per chat, an agent stopped on an approval or a
              question first, then whatever is new. Reply, approve or answer on the card itself; press next and the chat rests for an hour, so the one in front
              of you gets your whole attention.
            </p>
            <ul className="site-keys" aria-label="the Inbox's keys">
              <li>
                <kbd>→</kbd> next
              </li>
              <li>
                <kbd>E</kbd> archive
              </li>
              <li>
                <kbd>A</kbd> approve
              </li>
              <li>
                <kbd>R</kbd> reply
              </li>
              <li>
                <kbd>Z</kbd> undo
              </li>
            </ul>
            <p className="site-fine">Try it: the cards on the right are made-up chats, and the agents answer.</p>
          </div>
          <InboxDemo />
        </section>

        <section className="site-section" id="suggestions">
          <div className="site-section-text">
            <h2>Work that belongs in another chat goes there</h2>
            <p>
              Halfway through one job, an agent often turns up a piece of another: a line for the release notes, a bug worth its own chat. It writes that up as
              a suggestion for the chat it fits, and waits. You send it now, save it as a draft in that chat, point it at another chat or reject it; an agent
              never sends one itself.
            </p>
            <p className="site-fine">Try it: open a suggestion and send it, and the chat on the right answers.</p>
          </div>
          <SuggestionsDemo />
        </section>

        <section className="site-section site-section-phone" id="phone">
          <div className="site-section-text">
            <h2>Your phone is the remote</h2>
            <p>
              The Inbox, every chat, your agents and Learn on your phone, laid out for a thumb. Scan a code on your Mac, over Wi‑Fi or Tailscale, and add it to
              your home screen; there is nothing to install. What you read on one, the other knows.
            </p>
            <ul className="site-keys" aria-label="the phone's gestures">
              <li>swipe right: next</li>
              <li>swipe left: archive</li>
            </ul>
            <p className="site-fine">Try it: the phone on the right is live. The phone works with the Mac for now.</p>
          </div>
          <PhoneDemo />
        </section>

        <section className="site-section" id="learn">
          <div className="site-section-text">
            <h2>Keep what your chats taught you</h2>
            <p>
              When a conversation goes quiet, a writer in the background may draw a card or two from it: ideas that last, never the details of a task. A few
              minutes a day is enough, and each card comes back just before you would forget it. What went by without being understood becomes a lead, one
              lesson away. Learn is off until you switch it on.
            </p>
            <ul className="site-keys" aria-label="Learn's keys">
              <li>
                <kbd>space</kbd> show the answer
              </li>
              <li>
                <kbd>←</kbd> again
              </li>
              <li>
                <kbd>→</kbd> got it
              </li>
              <li>
                <kbd>X</kbd> delete
              </li>
            </ul>
          </div>
          <LearnDemo />
        </section>

        <section className="site-facts-section" aria-labelledby="yours">
          <h2 id="yours">Yours, on your own machine</h2>
          <ol className="site-facts">
            {FACTS.map((f) => (
              <li key={f.title}>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="site-cta">
          <h2>Give your agents a canvas</h2>
          <p className="site-lede">Free, open source, and running on your own Mac in a few minutes.</p>
          <div className="site-actions">
            <a className="site-button" href={RELEASES}>
              download for macOS
            </a>
            <a className="site-link" href={SOURCE}>
              source on GitHub →
            </a>
          </div>
          <Install />
        </section>
      </main>

      <footer className="site-footer">
        <span>loki · Apache-2.0</span>
        <a href={SOURCE}>GitHub</a>
        <a href={RELEASES}>releases</a>
      </footer>
    </div>
  );
}

/** The Homebrew line with a copy button. */
function Install() {
  return (
    <div className="site-install">
      <code>{BREW}</code>
      <button type="button" onClick={() => void navigator.clipboard.writeText(BREW).catch(() => {})}>
        copy
      </button>
    </div>
  );
}
