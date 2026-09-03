import { describe, expect, test } from "bun:test";

import {
  extractPuertoRicoZip,
  listingMatchesSearchFilters,
  parseRentalListingsSearchInput,
  projectRentalListing,
  projectRentalListingsSearch,
  rentalListingCoordinates,
  verifyRentalNeighborhood,
} from "./rental-listings";

describe("rental listing input", () => {
  test("accepts location, beds_min, and max_price only", () => {
    expect(parseRentalListingsSearchInput({
      location: "San Juan, PR",
      beds_min: 2,
      max_price: 5500,
    })).toEqual({
      location: "San Juan, PR",
      beds_min: 2,
      max_price: 5500,
    });
  });

  test("rejects extra keys", () => {
    expect(() => parseRentalListingsSearchInput({
      location: "San Juan, PR",
      endpoint: "/search",
    })).toThrow("listings.search accepts only location, beds_min, and max_price");
  });
});

describe("neighborhood verification", () => {
  test("maps 00918 to Hato Rey and 00907 to Condado/Miramar", () => {
    expect(verifyRentalNeighborhood({ zip: "00918" })).toMatchObject({
      zip: "00918",
      neighborhood: { name: "Hato Rey", source: "zip" },
    });
    expect(verifyRentalNeighborhood({ zip: "00907" })).toMatchObject({
      zip: "00907",
      neighborhood: { name: "Condado/Miramar", source: "zip" },
    });
    expect(verifyRentalNeighborhood({ zip: "00901" })).toMatchObject({
      zip: "00901",
      neighborhood: {
        name: "Old San Juan / Puerta de Tierra / Paseo Caribe",
        source: "zip",
      },
    });
  });

  test("does not treat Condado marketing copy as neighborhood", () => {
    expect(verifyRentalNeighborhood({
      buildingText: "Condado Available for rent. Sector - Condado",
      coordinates: rentalListingCoordinates(18.43624, -66.0600786),
    })).toMatchObject({
      neighborhood: { name: "Hato Rey", source: "coordinates" },
    });
  });

  test("binds Aquablue and 48 Luis Muñoz Rivera as Hato Rey 00918", () => {
    expect(verifyRentalNeighborhood({
      buildingText: "Condominio Aquablue hermoso apartamento",
      coordinates: rentalListingCoordinates(18.43624, -66.0600786),
    })).toEqual({
      streetAddress: "48 Ave Luis Muñoz Rivera",
      zip: "00918",
      neighborhood: { name: "Hato Rey", source: "known-address" },
    });
    expect(verifyRentalNeighborhood({
      streetAddress: "48 Luis Muñoz Rivera",
      buildingText: "Luxury Condado apartment",
    })).toMatchObject({
      zip: "00918",
      neighborhood: { name: "Hato Rey", source: "known-address" },
    });
  });

  test("extracts a Puerto Rico ZIP from listing text", () => {
    expect(extractPuertoRicoZip("Urb Eleanor Roosevelt 00918 San Juan")).toBe("00918");
    expect(extractPuertoRicoZip("no postal code here")).toBeNull();
  });
});

describe("rental listing projection", () => {
  test("sorts and rejects duplicate listing ids", () => {
    const first = projectRentalListing({
      id: "1974934",
      url: "https://www.clasificadosonline.com/UDRentalsDetail.asp?ReForRentAdID=1974934",
      rent: 3500,
      beds: 2,
      baths: 2,
      zip: "00918",
    });
    const second = projectRentalListing({
      id: "1915186",
      url: "https://www.clasificadosonline.com/UDRentalsDetail.asp?ReForRentAdID=1915186",
      rent: 1400,
      beds: 2,
      baths: 1,
      zip: "00909",
    });
    const search = projectRentalListingsSearch({
      provider: "clasificados",
      location: "San Juan, PR",
      url: "https://www.clasificadosonline.com/UDRentalsListingAdv.asp",
      observedAt: "2026-09-03T18:00:00.000Z",
      completeness: "complete",
      listings: [first, second],
    });
    expect(search.listings.map((listing) => listing.id)).toEqual(["1915186", "1974934"]);
    expect(() => projectRentalListingsSearch({
      provider: "clasificados",
      location: "San Juan, PR",
      url: "https://www.clasificadosonline.com/UDRentalsListingAdv.asp",
      observedAt: "2026-09-03T18:00:00.000Z",
      completeness: "complete",
      listings: [first, first],
    })).toThrow("rental listings search repeated one listing");
  });

  test("applies beds_min and max_price filters", () => {
    const listing = { beds: 2, rent: 3500 };
    expect(listingMatchesSearchFilters(listing, {
      location: "San Juan, PR",
      beds_min: 2,
      max_price: 5500,
    })).toBe(true);
    expect(listingMatchesSearchFilters(listing, {
      location: "San Juan, PR",
      beds_min: 3,
    })).toBe(false);
    expect(listingMatchesSearchFilters(listing, {
      location: "San Juan, PR",
      max_price: 3000,
    })).toBe(false);
  });
});
