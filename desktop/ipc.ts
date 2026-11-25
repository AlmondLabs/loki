export const INVOKE_CHANNEL = "loki:invoke";
export const EVENT_CHANNEL = "loki:event";
export const WINDOW_RESIZED_EVENT = "loki:window-resized";

export interface InvokeEvent<Frame, Sender> {
  readonly senderFrame: Frame | null;
  readonly sender: Sender;
}

export interface InvokeTarget<Frame, Sender> {
  handle(channel: string, listener: (event: InvokeEvent<Frame, Sender>, ...args: unknown[]) => Promise<unknown>): void;
}

export type InvokeHandler<Sender> = (args: Record<string, unknown>, sender: Sender) => unknown;

export interface InvokeOptions<Frame, Sender> {
  ipc: InvokeTarget<Frame, Sender>;
  trusted: (frame: Frame | null) => boolean;
  handlers: Record<string, InvokeHandler<Sender>>;
}

function argsOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("a command's arguments are an object");
  return Object.fromEntries(Object.entries(raw));
}

export function handleInvokes<Frame, Sender>({ ipc, trusted, handlers }: InvokeOptions<Frame, Sender>): void {
  ipc.handle(INVOKE_CHANNEL, async (event, command, args) => {
    if (!trusted(event.senderFrame)) throw new Error("loki answers only its own page");
    const handler = typeof command === "string" && Object.hasOwn(handlers, command) ? handlers[command] : undefined;
    if (!handler) throw new Error(`loki has no command ${typeof command === "string" ? command : typeof command}`);
    return await handler(argsOf(args), event.sender);
  });
}

export interface EventReceiver {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export function sendEvent(target: EventReceiver, name: string, payload: unknown): void {
  if (!target.isDestroyed()) target.send(EVENT_CHANNEL, name, payload);
}

export interface ResizingWindow {
  on(event: "resize" | "maximize" | "unmaximize", listener: () => void): unknown;
  readonly webContents: EventReceiver;
}

export function sendResizes(win: ResizingWindow): void {
  const resized = () => sendEvent(win.webContents, WINDOW_RESIZED_EVENT, null);
  win.on("resize", resized);
  win.on("maximize", resized);
  win.on("unmaximize", resized);
}

export interface WindowLike {
  setTitle(title: string): void;
  hide(): void;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  close(): void;
}

export interface OpenDialogOptions {
  properties: Array<"openFile" | "openDirectory" | "multiSelections">;
  defaultPath?: string;
  title?: string;
}

export interface WindowDeps<Sender, Win extends WindowLike> {
  windowOf: (sender: Sender) => Win | null;
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (path: string) => void;
  showOpenDialog: (window: Win, options: OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
  nativeTheme: { themeSource: "system" | "light" | "dark" };
}

const OPENABLE = new Set(["http:", "https:", "mailto:", "tel:"]);

export function openableUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !URL.canParse(raw)) return null;
  return OPENABLE.has(new URL(raw).protocol) ? raw : null;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`${name} is a string`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): Record<string, string> {
  const value = args[name];
  return typeof value === "string" ? { [name]: value } : {};
}

export function windowHandlers<Sender, Win extends WindowLike>(deps: WindowDeps<Sender, Win>): Record<string, InvokeHandler<Sender>> {
  const windowFor = (sender: Sender): Win => {
    const win = deps.windowOf(sender);
    if (!win) throw new Error("the window is gone");
    return win;
  };
  return {
    window_set_title: (args, sender) => windowFor(sender).setTitle(stringArg(args, "title")),
    window_hide: (_args, sender) => windowFor(sender).hide(),
    window_minimize: (_args, sender) => windowFor(sender).minimize(),
    window_toggle_maximize: (_args, sender) => {
      const win = windowFor(sender);
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    },
    window_close: (_args, sender) => windowFor(sender).close(),
    window_is_maximized: (_args, sender) => windowFor(sender).isMaximized(),
    window_set_theme: (args) => {
      deps.nativeTheme.themeSource = args.theme === "light" || args.theme === "dark" ? args.theme : "system";
    },
    open_url: async (args) => {
      const url = openableUrl(args.url);
      if (url) await deps.openExternal(url);
    },
    reveal_item: (args) => deps.showItemInFolder(stringArg(args, "path")),
    open_dialog: async (args, sender) => {
      const multiple = args.multiple === true;
      const options: OpenDialogOptions = {
        properties: [args.directory === true ? "openDirectory" : "openFile", ...(multiple ? (["multiSelections"] as const) : [])],
        ...optionalString(args, "defaultPath"),
        ...optionalString(args, "title"),
      };
      const { canceled, filePaths } = await deps.showOpenDialog(windowFor(sender), options);
      if (canceled || filePaths.length === 0) return null;
      return multiple ? filePaths : filePaths[0];
    },
  };
}
