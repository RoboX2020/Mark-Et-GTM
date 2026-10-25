import { describe, expect, it } from "vitest";
import { brightdataDiscoverInput, redditDateFromCutoff, xPostUrlsFromSerp } from "./social.js";

describe("brightdata helpers", () => {
  it("maps reddit keyword discovery with a required date filter", () => {
    const spec = brightdataDiscoverInput("reddit", "study planner", 40, "2026-08-31");
    expect(spec?.discoverBy).toBe("keyword");
    expect(spec?.input[0]).toMatchObject({ keyword: "study planner", date: redditDateFromCutoff("2026-08-31"), num_of_posts: 40 });
  });

  it("uses search_keyword for tiktok", () => {
    const spec = brightdataDiscoverInput("tiktok", "notion alternative", 25);
    expect(spec?.input[0]).toMatchObject({ search_keyword: "notion alternative", num_of_posts: 25 });
  });

  it("extracts x status urls from serp organic rows", () => {
    const urls = xPostUrlsFromSerp([
      { link: "https://x.com/someone/status/1234567890?utm=1" },
      { link: "https://www.reddit.com/r/test" },
      { url: "https://twitter.com/other/status/999" },
    ]);
    expect(urls).toEqual(["https://x.com/someone/status/1234567890", "https://x.com/other/status/999"]);
  });
});
