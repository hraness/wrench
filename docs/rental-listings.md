# Rental listings

Wrench exposes public Puerto Rico rental search as one named operation,
`listings.search`, on the built-in `clasificados-web` plugin.

The operation is read-only. It takes a location plus optional bedroom and rent
bounds, fetches the reviewed ClasificadosOnline list pages, and returns
structured rows. Each row includes the canonical listing URL, rent, beds, baths,
street address when the list card publishes one, ZIP when a reviewed ZIP table
or known-address override can prove it, and a neighborhood derived from that
address and ZIP or from the listing's own coordinates. Broker titles and
`BarrioCond` blurbs are never the neighborhood source.

## Input

Required key:

- `location` — a reviewed San Juan location token such as `San Juan, PR`,
  `Hato Rey`, `Condado`, `Santurce`, `Río Piedras`, or `Viejo San Juan`.

Optional keys:

- `beds_min` — keep listings with at least this many bedrooms. ClasificadosOnline
  treats its own bedroom field as an exact match, so Wrench omits that field
  from the query and applies the bound locally.
- `max_price` — keep listings at or below this monthly rent.

Unknown keys, extra fields, and locations outside the reviewed San Juan pueblo
set are rejected.

## Neighborhood verification

Listing text often lies. A Hato Rey tower can advertise Condado. Wrench resolves
neighborhood in this order:

1. A reviewed street-plus-ZIP override for a known building.
2. A reviewed San Juan ZIP when the listing or override publishes one.
3. Coordinates published on the same list card as the listing.

Reviewed ZIP examples:

- `00918` — Hato Rey
- `00907` — Condado / Miramar
- `00901` — Old San Juan / Puerta de Tierra / Paseo Caribe

Coordinates on ClasificadosOnline detail pages include related listings. The
runtime therefore binds latitude and longitude from the list card only.

## Completeness

San Juan is five ClasificadosOnline pueblos, not one island-wide search.
`location=San Juan, PR` walks those five reviewed list pages. Completeness is
`partial` when any page is full, when a page is truncated, or when a card is
skipped because it is not a San Juan listing. Completeness is `complete` only
when every requested pueblo page is a short, fully projected page.

## Live probe

A live ClasificadosOnline probe on 2026-09-03 for San Juan two-bedroom rentals
at or below $5500 returned real Hato Rey, Condado / Miramar, Santurce, Río
Piedras, and Old San Juan rows, including Aquablue at 48 Luis Muñoz Rivera with
neighborhood `Hato Rey` from the reviewed address override rather than the
listing title. Replay that probe with:

```bash
wrench clasificados-web listings.search \
  --input '{"location":"San Juan, PR","beds_min":2,"max_price":5500}' \
  --json
```

The command is a live network probe. Tests cover the same input against recorded
list-card fixtures so CI does not depend on the site.

## Surfaces that are not shipped

Zillow-group HTML and first-party search endpoints from this environment
returned PerimeterX or equivalent bot challenges on zillow.com, hotpads.com,
trulia.com, apartments.com, and homes.com. No reviewed public search contract
exists for those hosts, so Wrench does not ship a Zillow-group `listings.search`
and does not ship a DOM-click recipe.

Puerto Rico MLS public search is also not shipped. londonfoster.com's search
index is Florida inventory. puertoricorealtorsmls.com answered with a disk-full
error. stellarmls.com is a Florida member marketing site. Individual Puerto Rico
detail pages are not a reviewed search index.

Those blockers stay documented until a first-party public contract can be
reviewed. They are not capture-required stubs and they are not portable plugins.
