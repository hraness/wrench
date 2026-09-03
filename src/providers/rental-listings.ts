/**
 * Shared Puerto Rico rental-listing projection. Neighborhood is derived from
 * street, ZIP, known addresses, or list-card coordinates. Broker titles and
 * barrio blurbs are never a neighborhood source.
 */

export const RENTAL_LISTINGS_SCHEMA_VERSION = 1 as const;

export type RentalNeighborhoodSource = "zip" | "coordinates" | "known-address";

export type RentalNeighborhood = {
  readonly name: string;
  readonly source: RentalNeighborhoodSource;
};

export type RentalListingCoordinates = {
  readonly latitude: number;
  readonly longitude: number;
};

export type RentalListing = {
  readonly id: string;
  readonly url: string;
  readonly rent: number;
  readonly beds: number;
  readonly baths: number;
  readonly streetAddress: string | null;
  readonly zip: string | null;
  readonly neighborhood: RentalNeighborhood | null;
  readonly coordinates: RentalListingCoordinates | null;
};

export type RentalListingsSearch = {
  readonly schemaVersion: typeof RENTAL_LISTINGS_SCHEMA_VERSION;
  readonly provider: string;
  readonly target: {
    readonly kind: "search";
    readonly location: string;
    readonly url: string;
  };
  readonly observedAt: string;
  readonly completeness: "complete" | "partial";
  readonly listings: readonly RentalListing[];
};

export type RentalListingsSearchInput = {
  readonly location: string;
  readonly beds_min?: number;
  readonly max_price?: number;
};

const LOCATION_MAX_LENGTH = 80;
const STREET_MAX_LENGTH = 160;
const LISTING_ID_MAX_LENGTH = 32;
const RENT_MAXIMUM = 100_000;
const BEDS_MAXIMUM = 12;
const BATHS_MAXIMUM = 20;

const SAN_JUAN_ZIP_NEIGHBORHOODS = Object.freeze({
  "00901": "Old San Juan / Puerta de Tierra / Paseo Caribe",
  "00907": "Condado/Miramar",
  "00909": "Santurce",
  "00911": "Santurce",
  "00912": "Santurce",
  "00913": "Santurce",
  "00915": "Santurce",
  "00917": "Hato Rey",
  "00918": "Hato Rey",
  "00919": "Hato Rey",
  "00920": "Puerto Nuevo",
  "00921": "Río Piedras",
  "00923": "Río Piedras",
  "00924": "Río Piedras",
  "00925": "Río Piedras",
  "00926": "Río Piedras",
  "00927": "Río Piedras",
} as const);

type SanJuanZip = keyof typeof SAN_JUAN_ZIP_NEIGHBORHOODS;

type NeighborhoodBox = {
  readonly name: string;
  readonly minLatitude: number;
  readonly maxLatitude: number;
  readonly minLongitude: number;
  readonly maxLongitude: number;
};

/**
 * Conservative San Juan boxes. More specific districts are listed first so
 * Condado is not absorbed into Santurce.
 */
const SAN_JUAN_NEIGHBORHOOD_BOXES = Object.freeze([
  Object.freeze({
    name: "Old San Juan / Puerta de Tierra / Paseo Caribe",
    minLatitude: 18.458,
    maxLatitude: 18.48,
    minLongitude: -66.125,
    maxLongitude: -66.085,
  }),
  Object.freeze({
    name: "Condado/Miramar",
    minLatitude: 18.448,
    maxLatitude: 18.468,
    minLongitude: -66.09,
    maxLongitude: -66.058,
  }),
  Object.freeze({
    name: "Hato Rey",
    minLatitude: 18.408,
    maxLatitude: 18.442,
    minLongitude: -66.085,
    maxLongitude: -66.045,
  }),
  Object.freeze({
    name: "Río Piedras",
    minLatitude: 18.385,
    maxLatitude: 18.41,
    minLongitude: -66.065,
    maxLongitude: -66.03,
  }),
  Object.freeze({
    name: "Santurce",
    minLatitude: 18.437,
    maxLatitude: 18.456,
    minLongitude: -66.085,
    maxLongitude: -66.05,
  }),
] as const satisfies readonly NeighborhoodBox[]);

const KNOWN_ADDRESS_NEIGHBORHOODS = Object.freeze([
  Object.freeze({
    pattern: /\baquablue\b/u,
    streetAddress: "48 Ave Luis Muñoz Rivera",
    zip: "00918",
    neighborhood: "Hato Rey",
  }),
  Object.freeze({
    pattern: /\b48\s+(?:ave(?:nida)?\.?\s+)?luis\s+mu[nñ]oz\s+rivera\b/u,
    streetAddress: "48 Ave Luis Muñoz Rivera",
    zip: "00918",
    neighborhood: "Hato Rey",
  }),
] as const);

const ZIP_PATTERN = /\b(00[0-9]{3})\b/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return boundedString(value, label, maximum);
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a bounded integer`);
  }
  const integer = value as number;
  if (integer < minimum || integer > maximum) {
    throw new Error(`${label} must be a bounded integer`);
  }
  return integer;
}

function boundedHalfStep(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a bounded half-step count`);
  }
  const scaled = value * 2;
  if (!Number.isSafeInteger(scaled) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a bounded half-step count`);
  }
  return value;
}

function exactObservedAt(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("rental listings observedAt must be an exact UTC observation time");
  }
  return value;
}

function foldText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function puertoRicoZip(value: unknown, label = "ZIP"): string {
  const zip = boundedString(value, label, 5);
  if (!/^00[0-9]{3}$/u.test(zip)) {
    throw new Error(`${label} must be one Puerto Rico ZIP`);
  }
  return zip;
}

export function extractPuertoRicoZip(value: string): string | null {
  const match = ZIP_PATTERN.exec(value);
  return match?.[1] ?? null;
}

export function parseRentalListingsSearchInput(
  value: unknown,
): RentalListingsSearchInput {
  const input = record(value, "listings.search input");
  const keys = Object.keys(input).sort();
  for (const key of keys) {
    if (key !== "location" && key !== "beds_min" && key !== "max_price") {
      throw new Error("listings.search accepts only location, beds_min, and max_price");
    }
  }
  if (!keys.includes("location")) {
    throw new Error("listings.search requires input.location");
  }
  return Object.freeze({
    location: boundedString(input.location, "input.location", LOCATION_MAX_LENGTH),
    ...(input.beds_min === undefined
      ? {}
      : {
        beds_min: boundedInteger(input.beds_min, "input.beds_min", 0, BEDS_MAXIMUM),
      }),
    ...(input.max_price === undefined
      ? {}
      : {
        max_price: boundedInteger(
          input.max_price,
          "input.max_price",
          1,
          RENT_MAXIMUM,
        ),
      }),
  });
}

export function listingMatchesSearchFilters(
  listing: Pick<RentalListing, "beds" | "rent">,
  input: RentalListingsSearchInput,
): boolean {
  if (input.beds_min !== undefined && listing.beds < input.beds_min) return false;
  if (input.max_price !== undefined && listing.rent > input.max_price) return false;
  return true;
}

function neighborhoodFromZip(zip: string): RentalNeighborhood | null {
  const name = SAN_JUAN_ZIP_NEIGHBORHOODS[zip as SanJuanZip];
  if (name === undefined) return null;
  return Object.freeze({ name, source: "zip" });
}

function neighborhoodFromCoordinates(
  coordinates: RentalListingCoordinates,
): RentalNeighborhood | null {
  for (const box of SAN_JUAN_NEIGHBORHOOD_BOXES) {
    if (
      coordinates.latitude >= box.minLatitude
      && coordinates.latitude <= box.maxLatitude
      && coordinates.longitude >= box.minLongitude
      && coordinates.longitude <= box.maxLongitude
    ) {
      return Object.freeze({ name: box.name, source: "coordinates" });
    }
  }
  return null;
}

export function knownAddressMatch(value: string): {
  readonly streetAddress: string;
  readonly zip: string;
  readonly neighborhood: RentalNeighborhood;
} | null {
  const folded = foldText(value);
  for (const known of KNOWN_ADDRESS_NEIGHBORHOODS) {
    if (known.pattern.test(folded)) {
      return Object.freeze({
        streetAddress: known.streetAddress,
        zip: known.zip,
        neighborhood: Object.freeze({
          name: known.neighborhood,
          source: "known-address" as const,
        }),
      });
    }
  }
  return null;
}

export function verifyRentalNeighborhood(input: {
  readonly streetAddress?: string | null;
  readonly zip?: string | null;
  readonly coordinates?: RentalListingCoordinates | null;
  readonly buildingText?: string | null;
}): {
  readonly streetAddress: string | null;
  readonly zip: string | null;
  readonly neighborhood: RentalNeighborhood | null;
} {
  const buildingText = input.buildingText ?? "";
  const streetAddress = input.streetAddress ?? null;
  const known = knownAddressMatch(
    [streetAddress, buildingText].filter((part) => part !== null && part !== "").join(" "),
  );
  if (known !== null) {
    return Object.freeze({
      streetAddress: streetAddress ?? known.streetAddress,
      zip: known.zip,
      neighborhood: known.neighborhood,
    });
  }
  const zip = input.zip === undefined || input.zip === null
    ? null
    : puertoRicoZip(input.zip, "listing ZIP");
  if (zip !== null) {
    const fromZip = neighborhoodFromZip(zip);
    if (fromZip !== null) {
      return Object.freeze({
        streetAddress,
        zip,
        neighborhood: fromZip,
      });
    }
  }
  if (input.coordinates !== undefined && input.coordinates !== null) {
    return Object.freeze({
      streetAddress,
      zip,
      neighborhood: neighborhoodFromCoordinates(input.coordinates),
    });
  }
  return Object.freeze({
    streetAddress,
    zip,
    neighborhood: null,
  });
}

export function rentalListingCoordinates(
  latitude: unknown,
  longitude: unknown,
): RentalListingCoordinates {
  if (
    typeof latitude !== "number"
    || typeof longitude !== "number"
    || !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || latitude < 17.8
    || latitude > 18.6
    || longitude < -67.4
    || longitude > -65.2
  ) {
    throw new Error("listing coordinates must be one Puerto Rico point");
  }
  return Object.freeze({ latitude, longitude });
}

export function projectRentalListing(input: {
  readonly id: string;
  readonly url: string;
  readonly rent: number;
  readonly beds: number;
  readonly baths: number;
  readonly streetAddress?: string | null;
  readonly zip?: string | null;
  readonly coordinates?: RentalListingCoordinates | null;
  readonly buildingText?: string | null;
}): RentalListing {
  const id = boundedString(input.id, "listing id", LISTING_ID_MAX_LENGTH);
  if (!/^[0-9]{1,16}$/u.test(id)) {
    throw new Error("listing id must be one numeric classified identifier");
  }
  const verified = verifyRentalNeighborhood({
    streetAddress: optionalBoundedString(
      input.streetAddress,
      "listing street address",
      STREET_MAX_LENGTH,
    ),
    zip: input.zip ?? null,
    coordinates: input.coordinates ?? null,
    buildingText: input.buildingText ?? null,
  });
  return Object.freeze({
    id,
    url: boundedString(input.url, "listing URL", 512),
    rent: boundedInteger(input.rent, "listing rent", 1, RENT_MAXIMUM),
    beds: boundedInteger(input.beds, "listing beds", 0, BEDS_MAXIMUM),
    baths: boundedHalfStep(input.baths, "listing baths", 0, BATHS_MAXIMUM),
    streetAddress: verified.streetAddress,
    zip: verified.zip,
    neighborhood: verified.neighborhood,
    coordinates: input.coordinates ?? null,
  });
}

export function projectRentalListingsSearch(input: {
  readonly provider: string;
  readonly location: string;
  readonly url: string;
  readonly observedAt: string;
  readonly completeness: "complete" | "partial";
  readonly listings: readonly RentalListing[];
}): RentalListingsSearch {
  const listings = Object.freeze(
    [...input.listings].sort((left, right) => left.id.localeCompare(right.id, "en")),
  );
  const ids = new Set<string>();
  for (const listing of listings) {
    if (ids.has(listing.id)) {
      throw new Error("rental listings search repeated one listing");
    }
    ids.add(listing.id);
  }
  return Object.freeze({
    schemaVersion: RENTAL_LISTINGS_SCHEMA_VERSION,
    provider: boundedString(input.provider, "listings provider", 40),
    target: Object.freeze({
      kind: "search" as const,
      location: boundedString(input.location, "search location", LOCATION_MAX_LENGTH),
      url: boundedString(input.url, "search URL", 512),
    }),
    observedAt: exactObservedAt(input.observedAt),
    completeness: input.completeness,
    listings,
  });
}
