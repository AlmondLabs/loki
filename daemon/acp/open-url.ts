import { execFile } from "node:child_process";

/**
 * A web page in this computer's default browser (plan 042: an MCP server's sign-in an ACP agent asked for). The
 * address goes to the system's own opener as one argument, never through a shell; one that is not http(s) is refused.
 */
export function openInBrowser(url: string, report: (message: string) => void): void {
  if (!/^https?:\/\//i.test(url)) {
    report(`not opening ${url}: not a web address`);
    return;
  }
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  execFile(command, args, (error) => {
    if (error) report(`could not open the browser: ${error.message}`);
  });
}
