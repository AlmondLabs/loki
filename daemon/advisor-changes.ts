import { changeList, type ChangedFile, type ChangeList, type GitDeps } from "./changes.ts";

export type ChangesConsult = { text: string } | { notice: string };

const fileLine = (f: ChangedFile) => `- ${f.path}${f.added === null || f.deleted === null ? "" : ` (+${f.added} -${f.deleted})`}`;

const fileLines = (files: readonly ChangedFile[], more: number) => [...files.map(fileLine), ...(more ? [`- and ${more} more`] : [])];

export function consultTextOf(folder: string | undefined, list: ChangeList): ChangesConsult {
  const where = folder ?? "this chat's folder";
  switch (list.kind) {
    case "no_folder":
      return { notice: "Nothing to review: this chat has no folder." };
    case "not_a_checkout":
      return { notice: `Nothing to review: ${where} is not a git checkout.` };
    case "nothing_changed":
      return { notice: `Nothing to review: ${where} has no uncommitted changes and no commits that are not on its upstream.` };
    case "uncommitted":
      return { text: [`Review the uncommitted changes in ${where}:`, ...fileLines(list.files, list.more)].join("\n") };
    case "unpushed":
      return {
        text: [
          `Review the commits in ${where} not yet on ${list.upstream}:`,
          ...list.commits.map((c) => `- ${c.hash} ${c.subject}`),
          "",
          "The files they change:",
          ...fileLines(list.files, list.more),
        ].join("\n"),
      };
  }
}

export async function changesConsultText(folder: string | undefined, deps: GitDeps = {}): Promise<ChangesConsult> {
  return consultTextOf(folder, await changeList(folder, deps));
}
