/**
 * The product name as customers see it.
 *
 * It was written out by hand in every email template — subject lines,
 * headings, signatures — so a rename meant hunting eight separate string
 * literals across five files and hoping none were missed. Reading it from one
 * place makes the next rename a one-line change, or an env var with no deploy
 * at all.
 */
export const APP_BRAND_NAME = "EverySub";

/** Brand name, overridable per environment. */
export function brandName(configured?: string): string {
  return configured?.trim() || APP_BRAND_NAME;
}

/**
 * The From line for outgoing mail.
 *
 * The ADDRESS here deliberately still sits on prosperasub.com. Resend refuses
 * to send from a domain it hasn't verified, and `sendMail` throws on that
 * rejection — for password resets the throw is caught and logged, so the user
 * is told to check their inbox and no email ever arrives. Moving this to
 * @everysub.net before the domain is Verified in Resend silently locks people
 * out of their accounts.
 *
 * The display name is safe to change now: deliverability keys off the address
 * domain, not the label in front of it.
 *
 * In production MAIL_FROM is set as an environment variable and this default
 * is not used — switch that variable once, after verification.
 */
export const DEFAULT_MAIL_FROM = `${APP_BRAND_NAME} <no-reply@prosperasub.com>`;
