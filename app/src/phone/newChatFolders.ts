/**
 * The New chat sheet's folder (Home.tsx NewSheet): one of the folders the agent has worked in on the Mac
 * (`folders_get`, most recent first), the most recent to begin with.
 */

/** How many of an agent's folders the sheet offers before More; the rest are a tap away. */
export const FOLDER_CHOICES = 6;

/** The folders an agent worked in, most recent first; empty before the list arrives and when it has none. */
export function foldersOf(recent: Record<string, string[]> | null, agentId: string | null): string[] {
  return agentId && recent ? (recent[agentId] ?? []) : [];
}

/** The folder a new chat starts in: the one picked if this agent has worked there, else its most recent. */
export function chosenFolder(folders: string[], picked: string | null): string | null {
  return picked && folders.includes(picked) ? picked : (folders[0] ?? null);
}

/** The chips on show: the first FOLDER_CHOICES, plus the lit one if it is further down; all of them once More is tapped. */
export function shownFolders(folders: string[], folder: string | null, all: boolean): string[] {
  if (all) return folders;
  const first = folders.slice(0, FOLDER_CHOICES);
  return folder && !first.includes(folder) && folders.includes(folder) ? [...first, folder] : first;
}

/** A folder's name, the last part of its path. */
export const folderName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;
