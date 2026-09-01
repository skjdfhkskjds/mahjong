import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocalGameplayEvidence } from "./local-gameplay-evidence.js";

describe("local gameplay browser evidence", () => {
  it("renders strict viewer-only claim controls without authority state", () => {
    const markup = renderToStaticMarkup(<LocalGameplayEvidence />);

    expect(markup).toContain("Gameplay viewer smoke");
    expect(markup).toContain("Chow with tiles 44, 48");
    expect(markup).toContain("Declare win");
    expect(markup).not.toContain("canonicalState");
    expect(markup).not.toContain("eventHash");
  });
});
