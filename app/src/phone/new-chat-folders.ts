export const FOLDER_CHOICES = 6;

export function foldersOf(recent: Partial<Record<string, string[]>> | null, agentId: string | null): string[] {
  return agentId && recent ? (recent[agentId] ?? []) : [];
}

export function chosenFolder(folders: string[], picked: string | null): string | null {
  return picked && folders.includes(picked) ? picked : (folders[0] ?? null);
}

export function shownFolders(folders: string[], folder: string | null, all: boolean): string[] {
  if (all) return folders;
  const first = folders.slice(0, FOLDER_CHOICES);
  return folder && !first.includes(folder) && folders.includes(folder) ? [...first, folder] : first;
}

export const folderName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;
