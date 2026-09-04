export type CanonicalWhatsAppAccountKind = "pn" | "lid";

const CANONICAL_PN_ACCOUNT_PATTERN = /^[1-9][0-9]{4,14}$/u;
const CANONICAL_LID_ACCOUNT_PATTERN = /^[1-9][0-9]{4,19}$/u;
const CANONICAL_PARTICIPANT_JID_PATTERN =
  /^([1-9][0-9]{4,14})(?::[0-9]{1,5})?@s\.whatsapp\.net$|^([1-9][0-9]{4,19})(?::[0-9]{1,5})?@lid$/u;

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

export function canonicalWhatsAppAccountSubjectJid(subject: unknown): string {
  if (!isCanonicalWhatsAppAccountSubject(subject)) {
    throw new Error("WhatsApp account subject is not canonical");
  }
  const match = /^whatsapp:(pn|lid):([0-9]+)$/u.exec(subject);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("WhatsApp account subject is not canonical");
  }
  const [, kind, account] = match;
  return kind === "pn"
    ? `${account}@s.whatsapp.net`
    : `${account}@lid`;
}

export function canonicalWhatsAppParticipantJid(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("WhatsApp participant JID is not canonical");
  }
  const match = CANONICAL_PARTICIPANT_JID_PATTERN.exec(value);
  const account = match?.[1] ?? match?.[2];
  if (account === undefined) {
    throw new Error("WhatsApp participant JID is not canonical");
  }
  return match?.[1] === undefined
    ? `${account}@lid`
    : `${account}@s.whatsapp.net`;
}
