import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocalGameplayEvidence } from "./local-gameplay-evidence.js";

describe("local gameplay browser evidence", () => {
  it("renders strict viewer-only claim controls without authority state", () => {
    const markup = renderToStaticMarkup(<LocalGameplayEvidence />);

    expect(markup).toContain("Gameplay viewer smoke");
    expect(markup).toContain("Chow with 3 circles, 4 circles");
    expect(markup).toContain("Declare win");
    expect(markup).toContain('aria-label="Practice bot, bot"');
    expect(markup).toContain('aria-label="south player, human"');
    expect(markup).toContain("Autopilot");
    expect(markup).not.toContain("canonicalState");
    expect(markup).not.toContain("eventHash");
  });
});
