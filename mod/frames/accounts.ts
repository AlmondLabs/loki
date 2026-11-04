import { accountView, type Accounts } from "../accounts.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

/** What the account frames need from their host: this Mac's accounts (mod/accounts.ts); without them every frame fails. */
export interface AccountsDeps {
  accounts?: Pick<Accounts, "list" | "moveOwner" | "disconnect">;
}

/**
 * Preferences › Inbox accounts on the mod's socket (plan 067, U2): the accounts here and their owners, moving one to
 * another agent, and disconnecting one; and a paired Mac asking which accounts this Mac holds (KTD14). Connecting is
 * each provider's own frame. Every answer is the list as it now stands, without secrets or the watcher's cursor; the
 * host tells every client when it changed.
 */
export function accountFrames(deps: AccountsDeps): FrameHandlers {
  const need = () => {
    if (!deps.accounts) throw new Error("Inbox accounts are not available in this mod");
    return deps.accounts;
  };
  const listed = () => reply({ accounts: need().list().map(accountView) });
  return {
    account_list: listed,
    peer_accounts_get: listed,
    account_move: ({ account_id: accountId, owner_agent_id: ownerAgentId }) => {
      try {
        need().moveOwner(accountId, ownerAgentId);
      } catch (err) {
        return fail(errorMessage(err));
      }
      return listed();
    },
    account_disconnect: async ({ account_id: accountId }) => {
      try {
        if (!(await need().disconnect(accountId))) return fail("that account is not connected on this Mac");
      } catch (err) {
        return fail(errorMessage(err));
      }
      return listed();
    },
  };
}
