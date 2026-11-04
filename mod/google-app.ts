/**
 * The Google app a Gmail sign-in uses (plan 067, KTD5, R20). loki ships one shared app, so connecting Gmail is one
 * sign-in rather than building a Google Cloud project; a person may use an app of their own instead (Preferences ›
 * Inbox), whose id and secret are kept in the keychain with the account they signed in.
 */

/** A Google OAuth client: what a sign-in and every token refresh present to Google. */
export interface GoogleApp {
  client_id: string;
  client_secret: string;
}

/**
 * The shared app's client id: the Desktop client of the "loki" Google Cloud project. Google treats a desktop client's id
 * and secret as public (they ship inside every copy of an app), so they live in the source. The maintainer fills both
 * in; while they are empty, a sign-in with the shared app says so instead of calling Google.
 */
export const SHARED_GOOGLE_CLIENT_ID = "178065800575-fpkevdb0c2bh6s0l1vkun2udm26sj5m9.apps.googleusercontent.com";

/** The shared app's client secret, public by Google's design for a Desktop client; see SHARED_GOOGLE_CLIENT_ID. */
export const SHARED_GOOGLE_CLIENT_SECRET = "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";

/** The shared app as loki ships it. */
export const SHARED_GOOGLE_APP: GoogleApp = { client_id: SHARED_GOOGLE_CLIENT_ID, client_secret: SHARED_GOOGLE_CLIENT_SECRET };

/** What a sign-in says when this copy of loki carries no shared app. */
export const SHARED_APP_MISSING = "the shared Google app is not set; use your own Google app in Preferences › Inbox";

/** Whether an app has both halves of its credentials, so a sign-in or a refresh with it can reach Google at all. */
export const isUsableApp = (app: GoogleApp): boolean => app.client_id.trim() !== "" && app.client_secret.trim() !== "";

/** Google's token endpoint, where a code is redeemed and a refresh token exchanged. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google's authorization page, where the person signs in and allows loki in. */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * What a Gmail account keeps in the keychain (Accounts' secret, JSON): its tokens, when the access token stops working,
 * and the person's own app when they signed in with one, since a refresh must present the app that issued the tokens.
 */
export interface GmailSecret {
  access_token: string;
  refresh_token: string;
  /** ISO time the access token expires. */
  expires_at: string;
  own_app?: GoogleApp;
}

/** A Gmail account's secret as the keychain gives it back, or null when it is not one. */
export function parseGmailSecret(raw: string | null): GmailSecret | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.access_token !== "string" || typeof r.refresh_token !== "string" || !r.refresh_token || typeof r.expires_at !== "string") return null;
  const own = r.own_app as Record<string, unknown> | undefined;
  const ownApp =
    own && typeof own.client_id === "string" && typeof own.client_secret === "string"
      ? { client_id: own.client_id, client_secret: own.client_secret }
      : undefined;
  return { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_at, ...(ownApp ? { own_app: ownApp } : {}) };
}
