import { describe, expect, test } from "bun:test";

import type { PinnedHttpsFetch } from "../pinned-https";
import {
  CLASIFICADOS_PUBLIC_USER_AGENT,
  executeClasificadosPublicListingsSearch,
} from "./clasificados-web-runtime";

const recipe = {
  site: "clasificados",
  action: "listings.search",
  contractVersion: 1,
  timeoutMs: 60_000,
  maxOutputBytes: 2 * 1024 * 1024,
} as const;

function card(id: string, pueblo: string, lat: string, lon: string): string {
  return `<!-- Start: Classified row -->
<div itemscope="itemscope" itemtype="https://schema.org/place">
<meta itemprop="name" content="Condominio Aquablue hermoso apartamento" />
<span itemprop="offers" itemscope="itemscope" itemtype="https://schema.org/Offer">
<meta itemprop="price" content="3500" />
</span>
<meta itemprop="description" content="Condominio - Aquablue" />
</div>
<a href="/UDRentalsDetail.asp?ReForRentAdID=${id}"><span class="link-blue-color">Aquablue</span></a>
<img src="https://imgcache.clasificadosonline.com/UDClasMedia/ArteMobile/icon_cuartos.png" />
2
<img src="https://imgcache.clasificadosonline.com/UDClasMedia/ArteMobile/icon_bano.png" />
2
<a href="UDRentalsListingAdv.asp?RentalsPueblos=${pueblo}"><span>${pueblo}</span></a>
<input type="hidden" class="Lat" value="${lat}" />
<input type="hidden" class="Lon" value="${lon}" />
<input type="hidden" class="DetailUrl" value="https://www.clasificadosonline.com/UDRentalsDetail.asp?ReForRentAdID=${id}" />
<input type="hidden" class="Price" value="3500" />
<input type="hidden" class="BarrioCond" value="Aquablue" />
`;
}

function page(pueblo: string, id: string): string {
  return `<html><title>Alquiler ${pueblo}</title>${card(id, pueblo, "18.43624", "-66.0600786")}</html>`;
}

describe("Clasificados public listings runtime", () => {
  test("GETs each reviewed San Juan pueblo with the honest Wrench user agent", async () => {
    const urls: string[] = [];
    const fetch: PinnedHttpsFetch = (url, init, timeoutMs) => {
      urls.push(url.href);
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9",
          "user-agent": CLASIFICADOS_PUBLIC_USER_AGENT,
        },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(timeoutMs).toBe(60_000);
      const pueblo = url.searchParams.get("RentalsPueblos") ?? "San Juan - Hato Rey";
      const id = String(1_900_000 + urls.length);
      return Promise.resolve(new Response(Buffer.from(page(pueblo, id), "latin1"), {
        status: 200,
        headers: { "content-type": "text/html; charset=iso-8859-1" },
      }));
    };
    const result = await executeClasificadosPublicListingsSearch(
      recipe,
      { location: "San Juan, PR", beds_min: 2, max_price: 5500 },
      { fetch, now: () => Date.parse("2026-09-03T18:00:00.000Z") },
      undefined,
    );
    expect(urls).toHaveLength(5);
    expect(urls.every((url) => url.includes("RentalsPueblos="))).toBe(true);
    expect(urls.every((url) => url.includes("HighPrice=5500"))).toBe(true);
    expect(urls.every((url) => !url.includes("RESPueblos="))).toBe(true);
    expect(result).toMatchObject({
      status: "succeeded",
      dispatchStarted: false,
      output: {
        provider: "clasificados",
        completeness: "complete",
        target: { location: "San Juan, PR" },
      },
    });
    const output = result.output as { listings: readonly { id: string }[] };
    expect(output.listings).toHaveLength(5);
  });

  test("rejects an unreviewed content type without projecting cards", async () => {
    const fetch: PinnedHttpsFetch = () => Promise.resolve(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await executeClasificadosPublicListingsSearch(
      recipe,
      { location: "Hato Rey" },
      { fetch, now: () => Date.parse("2026-09-03T18:00:00.000Z") },
      undefined,
    );
    expect(result.status).toBe("failed");
  });
});
