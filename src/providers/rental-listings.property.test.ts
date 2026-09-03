import { test } from "bun:test";

import { assertProperty, fc } from "../test-support";
import {
  extractPuertoRicoZip,
  parseRentalListingsSearchInput,
  projectRentalListing,
  verifyRentalNeighborhood,
} from "./rental-listings";

const zipDigits = fc.integer({ min: 0, max: 999 }).map((value) =>
  `00${String(value).padStart(3, "0")}`);

test("Puerto Rico ZIP extraction is stable for 00xxx tokens", () => {
  assertProperty(fc.property(zipDigits, fc.string({ maxLength: 24 }), (zip, noise) => {
    const text = `${noise.replace(/00[0-9]{3}/gu, "")} ${zip} ${noise.replace(/00[0-9]{3}/gu, "")}`;
    const extracted = extractPuertoRicoZip(text);
    return extracted === zip || extracted === null;
  }));
});

test("listings.search input rejects extra keys", () => {
  assertProperty(fc.property(fc.string({ minLength: 1, maxLength: 12 }), (key) => {
    if (key === "location" || key === "beds_min" || key === "max_price") return true;
    try {
      parseRentalListingsSearchInput({ location: "San Juan, PR", [key]: 1 });
      return false;
    } catch (error) {
      return error instanceof Error
        && error.message === "listings.search accepts only location, beds_min, and max_price";
    }
  }));
});

test("known Aquablue text always verifies as Hato Rey 00918", () => {
  assertProperty(fc.property(fc.constantFrom(
    "Aquablue",
    "Condominio Aquablue",
    "48 Luis Muñoz Rivera",
    "48 Ave Luis Munoz Rivera",
  ), (text) => {
    const verified = verifyRentalNeighborhood({ buildingText: text });
    return verified.zip === "00918"
      && verified.neighborhood?.name === "Hato Rey"
      && verified.neighborhood.source === "known-address";
  }));
});

test("listing ids stay numeric after projection", () => {
  assertProperty(fc.property(fc.integer({ min: 1, max: 9_999_999 }), (id) => {
    const listing = projectRentalListing({
      id: String(id),
      url: `https://www.clasificadosonline.com/UDRentalsDetail.asp?ReForRentAdID=${id}`,
      rent: 2000,
      beds: 2,
      baths: 1,
      zip: "00918",
    });
    return listing.id === String(id) && listing.neighborhood?.name === "Hato Rey";
  }));
});
