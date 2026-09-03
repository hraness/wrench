import { describe, expect, test } from "bun:test";

import { clasificadosWebPlugin } from "./plugin";
import {
  executeClasificadosAuthenticatedOperation,
  probeClasificadosWebSubject,
} from "../../providers/clasificados-web-runtime";

const binding = clasificadosWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("Clasificados web-session binding is unavailable");
}

describe("Clasificados provider plugin", () => {
  test("advertises public listings.search", () => {
    expect(clasificadosWebPlugin).toMatchObject({
      id: "clasificados-web",
      version: "1.0.0",
      sourceKind: "built-in",
    });
    expect(binding).toMatchObject({
      surfaceId: "clasificados",
      origin: "https://www.clasificadosonline.com",
      manifestOrigins: ["https://www.clasificadosonline.com"],
      protectedHostnameFamilies: ["www.clasificadosonline.com"],
      authKinds: ["browser-profile"],
    });
    expect(binding.operations).toHaveLength(1);
    expect(binding.operations[0]).toMatchObject({
      name: "listings.search",
      access: "public",
      contractVersion: 1,
      risk: "R1",
      state: "observed",
      dispatch: "none",
      input: {
        required: ["location"],
      },
    });
    expect(binding.executePublic).toBeFunction();
  });

  test("keeps authenticated hooks inert", async () => {
    await expect(probeClasificadosWebSubject({
      schemaVersion: 1,
      id: "unused",
      kind: "browser-profile",
      profile: "unused",
      trustUnfilteredEgress: true,
    })).rejects.toThrow("do not use an auth realm");
    await expect(executeClasificadosAuthenticatedOperation())
      .rejects.toThrow("no installed authenticated web operations");
  });
});
