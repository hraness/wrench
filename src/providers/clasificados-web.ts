/**
 * ClasificadosOnline public rental-list policy. Callers choose a locality and
 * optional bed/price bounds. Wrench owns the reviewed list URL, query names,
 * card projection, and neighborhood verification.
 */

import type { WebSessionContract } from "../web-session-contract-definitions";
import {
  extractPuertoRicoZip,
  listingMatchesSearchFilters,
  projectRentalListing,
  projectRentalListingsSearch,
  rentalListingCoordinates,
  type RentalListing,
  type RentalListingsSearch,
  type RentalListingsSearchInput,
} from "./rental-listings";

export const CLASIFICADOS_WEB_OPERATION_NAMES = Object.freeze([
  "listings.search",
] as const);

export type ClasificadosWebOperationName =
  (typeof CLASIFICADOS_WEB_OPERATION_NAMES)[number];

export const CLASIFICADOS_WEB_OPERATIONS = Object.freeze({
  "listings.search": Object.freeze({
    effect: "read" as const,
    risk: "R1" as const,
    state: "observed" as const,
    reason:
      "fixed credential-free rental-list GET binds reviewed pueblo values, projects each comment-marked card from schema.org and list-row hidden coordinates, then verifies neighborhood from street, ZIP, known address, or those coordinates",
  }),
});

export const CLASIFICADOS_ORIGIN = "https://www.clasificadosonline.com";
export const CLASIFICADOS_LIST_PATH = "/UDRentalsListingAdv.asp";
export const CLASIFICADOS_DETAIL_PATH = "/UDRentalsDetail.asp";
export const CLASIFICADOS_PAGE_SIZE = 15;
export const CLASIFICADOS_MAX_PAGES_PER_PUEBLO = 1;
export const CLASIFICADOS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const CLASIFICADOS_SAN_JUAN_PUEBLOS = Object.freeze([
  "San Juan - Condado-Miramar",
  "San Juan - Hato Rey",
  "San Juan - Río Piedras",
  "San Juan - Santurce",
  "San Juan - Viejo SJ",
] as const);

export type ClasificadosPueblo = (typeof CLASIFICADOS_SAN_JUAN_PUEBLOS)[number];

export const CLASIFICADOS_LISTINGS_SEARCH_INPUT = Object.freeze({
  properties: Object.freeze({
    location: Object.freeze({
      type: "string" as const,
      description: "Exact rental search locality",
      minLength: 1,
      maxLength: 80,
    }),
    beds_min: Object.freeze({
      type: "number" as const,
      description: "Minimum bedroom count",
      minimum: 0,
      maximum: 12,
    }),
    max_price: Object.freeze({
      type: "number" as const,
      description: "Maximum monthly rent in USD",
      minimum: 1,
      maximum: 100_000,
    }),
  }),
  required: Object.freeze(["location"]),
});

export const CLASIFICADOS_LISTINGS_SEARCH_CONTRACT: WebSessionContract =
  Object.freeze({
    site: "clasificados",
    operation: "listings.search",
    contractVersion: 1,
    risk: "R1",
    input: CLASIFICADOS_LISTINGS_SEARCH_INPUT,
    sideEffect: "none",
    idempotency: "none",
    dedupeWindowMs: 0,
    state: "observed",
    dispatch: "none",
    implementation: CLASIFICADOS_WEB_OPERATIONS["listings.search"].reason,
  });

const STREET_PATTERN =
  /\b(?:calle|ave(?:nida)?\.?|av\.?|urb(?:anizaci[oó]n)?\.?|cond(?:ominio)?\.?)\s+[^,]{2,80}/iu;
const NUMBERED_STREET_PATTERN =
  /\b\d{1,5}\s+(?:calle|ave(?:nida)?\.?|av\.?|luis\s+mu[nñ]oz\s+rivera)\b[^,]{0,60}/iu;

function foldLocation(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function clasificadosPueblosForLocation(
  location: string,
): readonly ClasificadosPueblo[] {
  const folded = foldLocation(location);
  if (
    folded === "san juan"
    || folded === "san juan pr"
    || folded === "san juan puerto rico"
  ) {
    return CLASIFICADOS_SAN_JUAN_PUEBLOS;
  }
  if (folded === "hato rey" || folded === "san juan hato rey") {
    return Object.freeze(["San Juan - Hato Rey"]);
  }
  if (
    folded === "condado"
    || folded === "miramar"
    || folded === "condado miramar"
    || folded === "san juan condado miramar"
  ) {
    return Object.freeze(["San Juan - Condado-Miramar"]);
  }
  if (folded === "santurce" || folded === "san juan santurce") {
    return Object.freeze(["San Juan - Santurce"]);
  }
  if (folded === "rio piedras" || folded === "san juan rio piedras") {
    return Object.freeze(["San Juan - Río Piedras"]);
  }
  if (
    folded === "viejo san juan"
    || folded === "old san juan"
    || folded === "osj"
    || folded === "san juan viejo sj"
  ) {
    return Object.freeze(["San Juan - Viejo SJ"]);
  }
  throw new Error("listings.search location is not one reviewed Puerto Rico rental locality");
}

export function clasificadosListUrl(
  pueblo: ClasificadosPueblo,
  input: RentalListingsSearchInput,
  offset = 0,
): URL {
  const url = new URL(CLASIFICADOS_LIST_PATH, CLASIFICADOS_ORIGIN);
  url.searchParams.set("RentalsPueblos", pueblo);
  url.searchParams.set("Category", "Apartamento");
  if (input.max_price !== undefined) {
    url.searchParams.set("HighPrice", String(input.max_price));
  }
  if (offset > 0) {
    url.searchParams.set("offset", String(offset));
  }
  return url;
}

export function clasificadosSearchTargetUrl(
  location: string,
  input: RentalListingsSearchInput,
): string {
  const pueblos = clasificadosPueblosForLocation(location);
  if (pueblos.length === 1 && pueblos[0] !== undefined) {
    return clasificadosListUrl(pueblos[0], input).href;
  }
  return clasificadosListUrl("San Juan - Hato Rey", input).href;
}

export function clasificadosDetailUrl(id: string): string {
  if (!/^[0-9]{1,16}$/u.test(id)) {
    throw new Error("Clasificados listing id must be one numeric classified identifier");
  }
  const url = new URL(CLASIFICADOS_DETAIL_PATH, CLASIFICADOS_ORIGIN);
  url.searchParams.set("ReForRentAdID", id);
  return url.href;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&iacute;/giu, "í")
    .replace(/&oacute;/giu, "ó")
    .replace(/&aacute;/giu, "á")
    .replace(/&eacute;/giu, "é")
    .replace(/&uacute;/giu, "ú")
    .replace(/&ntilde;/giu, "ñ")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCharCode(Number(code)));
}

function collapseWhitespace(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/gu, " ").trim();
}

function metaContent(html: string, itemprop: string): string | null {
  const pattern = new RegExp(
    `itemprop="${itemprop}"\\s+content="([^"]*)"`,
    "iu",
  );
  const match = pattern.exec(html);
  if (match?.[1] === undefined) return null;
  const value = collapseWhitespace(match[1]);
  return value.length > 0 ? value : null;
}

function hiddenClassValue(html: string, className: string): string | null {
  const pattern = new RegExp(
    `<input\\s+type="hidden"\\s+class="${className}"\\s+value="([^"]*)"`,
    "iu",
  );
  const match = pattern.exec(html);
  if (match?.[1] === undefined) return null;
  const value = collapseWhitespace(match[1]);
  return value.length > 0 ? value : null;
}

function afterIcon(html: string, iconFile: string): string | null {
  const index = html.indexOf(iconFile);
  if (index < 0) return null;
  const after = html.slice(index + iconFile.length);
  const match = />\s*([^<]+)/u.exec(after);
  if (match?.[1] === undefined) return null;
  const value = collapseWhitespace(match[1]);
  return value.length > 0 ? value : null;
}

function parseCount(value: string, label: string): number {
  if (/^(?:estudio|efficiency)$/iu.test(value)) return 0;
  const match = /^([0-9]{1,2})(?:\.[05])?$/u.exec(value);
  if (match?.[1] === undefined) {
    throw new Error(`${label} was not a reviewed room count`);
  }
  return Number(match[1]);
}

function puebloFromCard(html: string): string | null {
  const match = /RentalsPueblos=([^"]+)"/u.exec(html);
  if (match?.[1] === undefined) return null;
  const pueblo = collapseWhitespace(decodeURIComponent(match[1].replace(/\+/gu, " ")));
  return pueblo.length > 0 ? pueblo : null;
}

function listingIdFromCard(html: string, detailUrl: string | null): string {
  const fromUrl = /ReForRentAdID=([0-9]{1,16})/u.exec(detailUrl ?? "");
  if (fromUrl?.[1] !== undefined) return fromUrl[1];
  const fromHref = /UDRentalsDetail\.asp\?ReForRentAdID=([0-9]{1,16})/u.exec(html);
  if (fromHref?.[1] === undefined) {
    throw new Error("Clasificados card did not bind one listing identifier");
  }
  return fromHref[1];
}

function exactDetailUrl(id: string, raw: string | null): string {
  const expected = clasificadosDetailUrl(id);
  if (raw === null) return expected;
  let url: URL;
  try {
    url = new URL(raw, CLASIFICADOS_ORIGIN);
  } catch {
    throw new Error("Clasificados card detail URL was invalid");
  }
  if (
    url.origin !== CLASIFICADOS_ORIGIN
    || url.pathname !== CLASIFICADOS_DETAIL_PATH
    || url.searchParams.get("ReForRentAdID") !== id
    || [...url.searchParams.keys()].join(",") !== "ReForRentAdID"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) {
    throw new Error("Clasificados card detail URL drifted");
  }
  return expected;
}

function extractStreetAddress(
  title: string | null,
  description: string | null,
): string | null {
  const text = [title, description].filter((part) => part !== null).join(" ");
  const numbered = NUMBERED_STREET_PATTERN.exec(text);
  if (numbered?.[0] !== undefined) return collapseWhitespace(numbered[0]);
  const named = STREET_PATTERN.exec(text);
  if (named?.[0] === undefined) return null;
  return collapseWhitespace(named[0]);
}

function cardChunks(html: string): readonly string[] {
  const starts = [
    ...html.matchAll(/<!--\s*Start:\s*Classified row\s*-->/gu),
  ].map((match) => match.index);
  const chunks: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const next = starts[index + 1] ?? html.length;
    if (start === undefined) continue;
    chunks.push(html.slice(start, next));
  }
  return Object.freeze(chunks);
}

export function projectClasificadosListingCard(
  html: string,
  expectedPueblo?: ClasificadosPueblo,
): RentalListing {
  const title = metaContent(html, "name");
  const priceText = hiddenClassValue(html, "Price") ?? metaContent(html, "price");
  const description = metaContent(html, "description");
  const bedsText = afterIcon(html, "icon_cuartos.png");
  const bathsText = afterIcon(html, "icon_bano.png");
  const rawLat = hiddenClassValue(html, "Lat");
  const rawLon = hiddenClassValue(html, "Lon");
  const rawDetail = hiddenClassValue(html, "DetailUrl");
  const pueblo = puebloFromCard(html);
  if (title === null || priceText === null || bedsText === null || bathsText === null) {
    throw new Error("Clasificados card was missing a reviewed listing field");
  }
  if (pueblo === null) {
    throw new Error("Clasificados card did not bind one pueblo");
  }
  if (expectedPueblo !== undefined && pueblo !== expectedPueblo) {
    throw new Error("Clasificados card pueblo did not match the requested list");
  }
  if (!pueblo.startsWith("San Juan")) {
    throw new Error("Clasificados card is outside the requested San Juan locality");
  }
  const id = listingIdFromCard(html, rawDetail);
  const rent = Number(priceText.replace(/[^0-9]/gu, ""));
  const coordinates = rawLat !== null && rawLon !== null
    ? rentalListingCoordinates(Number(rawLat), Number(rawLon))
    : null;
  const streetAddress = extractStreetAddress(title, description);
  const zip = extractPuertoRicoZip(`${title} ${description ?? ""}`);
  return projectRentalListing({
    id,
    url: exactDetailUrl(id, rawDetail),
    rent,
    beds: parseCount(bedsText, "Clasificados beds"),
    baths: parseCount(bathsText, "Clasificados baths"),
    streetAddress,
    zip,
    coordinates,
    buildingText: [title, description].filter((part) => part !== null).join(" "),
  });
}

export function projectClasificadosListPage(
  html: string,
  expectedPueblo: ClasificadosPueblo,
  input: RentalListingsSearchInput,
): {
  readonly listings: readonly RentalListing[];
  readonly pageFull: boolean;
} {
  if (!/<!--\s*Start:\s*Classified row\s*-->/u.test(html)) {
    if (/UDRentalsListingAdv\.asp/u.test(html) || /RentalsPueblos/u.test(html)) {
      return Object.freeze({ listings: Object.freeze([]), pageFull: false });
    }
    throw new Error("Clasificados list page did not match the reviewed rental-list contract");
  }
  const listings: RentalListing[] = [];
  for (const chunk of cardChunks(html)) {
    try {
      const listing = projectClasificadosListingCard(chunk, expectedPueblo);
      if (listingMatchesSearchFilters(listing, input)) listings.push(listing);
    } catch (error) {
      if (
        error instanceof Error
        && (
          error.message === "Clasificados card pueblo did not match the requested list"
          || error.message === "Clasificados card is outside the requested San Juan locality"
        )
      ) {
        continue;
      }
      throw error;
    }
  }
  return Object.freeze({
    listings: Object.freeze(listings),
    pageFull: cardChunks(html).length >= CLASIFICADOS_PAGE_SIZE,
  });
}

export function projectClasificadosListingsSearch(
  pages: readonly {
    readonly pueblo: ClasificadosPueblo;
    readonly html: string;
  }[],
  input: RentalListingsSearchInput,
  observedAt: string,
): RentalListingsSearch {
  const listings: RentalListing[] = [];
  const ids = new Set<string>();
  let pageFull = false;
  for (const page of pages) {
    const projected = projectClasificadosListPage(page.html, page.pueblo, input);
    pageFull = pageFull || projected.pageFull;
    for (const listing of projected.listings) {
      if (ids.has(listing.id)) continue;
      ids.add(listing.id);
      listings.push(listing);
    }
  }
  return projectRentalListingsSearch({
    provider: "clasificados",
    location: input.location,
    url: clasificadosSearchTargetUrl(input.location, input),
    observedAt,
    completeness: pageFull ? "partial" : "complete",
    listings,
  });
}
