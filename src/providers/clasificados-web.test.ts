import { describe, expect, test } from "bun:test";

import {
  CLASIFICADOS_LISTINGS_SEARCH_CONTRACT,
  CLASIFICADOS_SAN_JUAN_PUEBLOS,
  clasificadosDetailUrl,
  clasificadosListUrl,
  clasificadosPueblosForLocation,
  projectClasificadosListingCard,
  projectClasificadosListingsSearch,
} from "./clasificados-web";

function classifiedRow(options: {
  readonly id: string;
  readonly name: string;
  readonly price: string;
  readonly description: string;
  readonly beds: string;
  readonly baths: string;
  readonly pueblo: string;
  readonly barrio: string;
  readonly lat: string;
  readonly lon: string;
}): string {
  return `<!-- Start: Classified row -->
<div itemscope="itemscope" itemtype="https://schema.org/place">
<meta itemprop="name" content="${options.name}" />
<span itemprop="offers" itemscope="itemscope" itemtype="https://schema.org/Offer">
<meta itemprop="price" content="${options.price}" />
</span>
<meta itemprop="description" content="${options.description}" />
</div>
<a href="/UDRentalsDetail.asp?ReForRentAdID=${options.id}">
<span class="link-blue-color">${options.name}</span>
</a>
<img src="https://imgcache.clasificadosonline.com/UDClasMedia/ArteMobile/icon_cuartos.png" />
${options.beds}
<img src="https://imgcache.clasificadosonline.com/UDClasMedia/ArteMobile/icon_bano.png" />
${options.baths}
<a href="UDRentalsListingAdv.asp?RentalsPueblos=${options.pueblo}">
<span>${options.pueblo}</span>
</a>
<!-- Set hidden fields for Tomtom map  -->
<input type="hidden" class="Lat" value="${options.lat}" />
<input type="hidden" class="Lon" value="${options.lon}" />
<input type="hidden" class="DetailUrl" value="https://www.clasificadosonline.com/UDRentalsDetail.asp?ReForRentAdID=${options.id}" />
<input type="hidden" class="Price" value="${options.price}" />
<input type="hidden" class="BarrioCond" value="${options.barrio}" />
<!--  End: Classified row  -->`;
}

const aquablueCard = classifiedRow({
  id: "1974934",
  name: "Condominio Aquablue hermoso apartamento",
  price: "3500",
  description: "Condominio - Aquablue",
  beds: "2",
  baths: "2",
  pueblo: "San Juan - Hato Rey",
  barrio: "Aquablue",
  lat: "18.43624",
  lon: "-66.0600786",
});

const fakeCondadoCard = classifiedRow({
  id: "1973059",
  name: "Condado Available for rent.",
  price: "2500",
  description: "Sector - Condado",
  beds: "2",
  baths: "1",
  pueblo: "San Juan - Hato Rey",
  barrio: "Condado",
  lat: "18.4203835",
  lon: "-66.0451047",
});

const caguasLeakCard = classifiedRow({
  id: "1967766",
  name: "COND. TORRE DEL SOL - AGUADILLA",
  price: "1200",
  description: "Condominio - Torre Del Sol",
  beds: "2",
  baths: "1",
  pueblo: "Caguas",
  barrio: "Torre Del Sol",
  lat: "18.234",
  lon: "-66.161",
});

const santurceCard = classifiedRow({
  id: "1915186",
  name: "Apt de lujo unidad D",
  price: "1400",
  description: "Barrio - Santurce Sur",
  beds: "2",
  baths: "1",
  pueblo: "San Juan - Santurce",
  barrio: "Santurce Sur",
  lat: "18.449",
  lon: "-66.066",
});

const oneBedroomCard = classifiedRow({
  id: "1880001",
  name: "Studio near hospitals",
  price: "900",
  description: "Urbanizacion - Valencia",
  beds: "1",
  baths: "1",
  pueblo: "San Juan - Río Piedras",
  barrio: "Valencia",
  lat: "18.399",
  lon: "-66.048",
});

const listPage = (cards: string): string =>
  `<html><title>Alquiler San Juan</title><form action="UDRentalsListingAdv.asp?RentalsPueblos=San+Juan+-+Hato+Rey">${cards}</form></html>`;

describe("Clasificados location mapping", () => {
  test("maps San Juan, PR to the five reviewed pueblos", () => {
    expect(clasificadosPueblosForLocation("San Juan, PR")).toEqual([
      ...CLASIFICADOS_SAN_JUAN_PUEBLOS,
    ]);
    expect(clasificadosPueblosForLocation("Hato Rey")).toEqual([
      "San Juan - Hato Rey",
    ]);
  });

  test("rejects an unreviewed locality", () => {
    expect(() => clasificadosPueblosForLocation("Miami, FL"))
      .toThrow("listings.search location is not one reviewed Puerto Rico rental locality");
  });

  test("builds the reviewed RentalsPueblos list URL", () => {
    expect(clasificadosListUrl("San Juan - Hato Rey", {
      location: "San Juan, PR",
      beds_min: 2,
      max_price: 5500,
    }).href).toBe(
      "https://www.clasificadosonline.com/UDRentalsListingAdv.asp?RentalsPueblos=San+Juan+-+Hato+Rey&Category=Apartamento&HighPrice=5500",
    );
    expect(clasificadosDetailUrl("1974934")).toBe(
      "https://www.clasificadosonline.com/UDRentalsDetail.asp?ReForRentAdID=1974934",
    );
  });
});

describe("Clasificados card projection", () => {
  test("projects Aquablue as Hato Rey from the known address, not listing copy", () => {
    expect(projectClasificadosListingCard(aquablueCard)).toMatchObject({
      id: "1974934",
      url: "https://www.clasificadosonline.com/UDRentalsDetail.asp?ReForRentAdID=1974934",
      rent: 3500,
      beds: 2,
      baths: 2,
      zip: "00918",
      neighborhood: { name: "Hato Rey", source: "known-address" },
    });
  });

  test("ignores Condado marketing copy when coordinates are Hato Rey", () => {
    expect(projectClasificadosListingCard(fakeCondadoCard)).toMatchObject({
      id: "1973059",
      rent: 2500,
      beds: 2,
      baths: 1,
      neighborhood: { name: "Hato Rey", source: "coordinates" },
    });
  });

  test("drops featured cards outside San Juan", () => {
    expect(() => projectClasificadosListingCard(caguasLeakCard))
      .toThrow("Clasificados card is outside the requested San Juan locality");
  });
});

describe("Clasificados list search projection", () => {
  test("keeps San Juan 2BR rows under max_price and drops leaks and 1BR", () => {
    const result = projectClasificadosListingsSearch([
      {
        pueblo: "San Juan - Hato Rey",
        html: listPage(aquablueCard + fakeCondadoCard + caguasLeakCard),
      },
      {
        pueblo: "San Juan - Santurce",
        html: listPage(santurceCard + oneBedroomCard),
      },
    ], {
      location: "San Juan, PR",
      beds_min: 2,
      max_price: 5500,
    }, "2026-09-03T18:00:00.000Z");
    expect(result).toMatchObject({
      schemaVersion: 1,
      provider: "clasificados",
      completeness: "complete",
      target: { kind: "search", location: "San Juan, PR" },
    });
    expect(result.listings.map((listing) => listing.id)).toEqual([
      "1915186",
      "1973059",
      "1974934",
    ]);
    expect(result.listings.find((listing) => listing.id === "1974934")?.neighborhood)
      .toEqual({ name: "Hato Rey", source: "known-address" });
  });
});

describe("Clasificados contract", () => {
  test("owns one observed public listings.search contract", () => {
    expect(CLASIFICADOS_LISTINGS_SEARCH_CONTRACT).toMatchObject({
      site: "clasificados",
      operation: "listings.search",
      contractVersion: 1,
      risk: "R1",
      state: "observed",
      dispatch: "none",
      input: {
        required: ["location"],
      },
    });
  });
});
