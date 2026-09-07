/**
 * The shape of a pairing code, shared by the mod that mints it (mod/pairing.ts) and the phone page
 * that lets the user type it (app/src/phone). Six characters from an alphabet without 0/O and 1/I.
 */
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_LENGTH = 6;
