export type CanonicalWhatsAppAccountKind = "pn" | "lid";

const CANONICAL_PN_ACCOUNT_PATTERN = /^[1-9][0-9]{4,14}$/u;
const CANONICAL_LID_ACCOUNT_PATTERN = /^[1-9][0-9]{4,19}$/u;

export function isCanonicalWhatsAppAccountId(
  kind: CanonicalWhatsAppAccountKind,
  value: unknown,
): value is string {
  return typeof value === "string" && (
    kind === "pn"
      ? CANONICAL_PN_ACCOUNT_PATTERN.test(value)
      : CANONICAL_LID_ACCOUNT_PATTERN.test(value)
  );
}

export function isCanonicalWhatsAppAccountSubject(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^whatsapp:(pn|lid):([0-9]+)$/u.exec(value);
  const kind = match?.[1];
  const account = match?.[2];
  return (kind === "pn" || kind === "lid")
    && account !== undefined
    && isCanonicalWhatsAppAccountId(kind, account);
}
