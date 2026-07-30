/** Registry-free subject predicates shared by official provider transports. */
export function isXAccountSubject(value: string): boolean {
  return /^[0-9]{1,19}$/u.test(value);
}

export function isLinkedInWebAccountSubject(value: string): boolean {
  return /^urn:li:fsd_profile:[0-9]{1,32}$/u.test(value);
}

export function isLinkedInProviderActorSubject(value: string): boolean {
  return /^urn:li:(?:person:[A-Za-z0-9_-]{1,256}|organization:[0-9]{1,32})$/u.test(value);
}
