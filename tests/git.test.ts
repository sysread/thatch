import { describe, test, expect } from "bun:test";
import { parseGitUrl } from "../src/git";

describe("parseGitUrl", () => {
  test("SSH shorthand: git@github.com:owner/repo.git", () => {
    expect(parseGitUrl("git@github.com:anomalyco/thatch.git")).toBe("anomalyco/thatch");
  });

  test("SSH shorthand without .git suffix", () => {
    expect(parseGitUrl("git@github.com:anomalyco/thatch")).toBe("anomalyco/thatch");
  });

  test("HTTPS URL", () => {
    expect(parseGitUrl("https://github.com/anomalyco/thatch.git")).toBe("anomalyco/thatch");
  });

  test("HTTPS URL without .git", () => {
    expect(parseGitUrl("https://github.com/anomalyco/thatch")).toBe("anomalyco/thatch");
  });

  test("HTTP URL", () => {
    expect(parseGitUrl("http://github.com/anomalyco/thatch.git")).toBe("anomalyco/thatch");
  });

  test("SSH full URL: ssh://git@github.com/owner/repo.git", () => {
    expect(parseGitUrl("ssh://git@github.com/anomalyco/thatch.git")).toBe("anomalyco/thatch");
  });

  test("Git protocol: git://github.com/owner/repo.git", () => {
    expect(parseGitUrl("git://github.com/anomalyco/thatch.git")).toBe("anomalyco/thatch");
  });

  test("GitLab HTTPS", () => {
    expect(parseGitUrl("https://gitlab.com/anomalyco/thatch.git")).toBe("anomalyco/thatch");
  });

  test("self-hosted GitLab", () => {
    expect(parseGitUrl("git@gitlab.internal:team/project.git")).toBe("team/project");
  });

  test("returns null for unknown format", () => {
    expect(parseGitUrl("not-a-url")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseGitUrl("")).toBeNull();
  });

  test("handles repo names with hyphens and dots", () => {
    expect(parseGitUrl("git@github.com:my-org/my-repo.name.git")).toBe("my-org/my-repo.name");
  });

  test("handles trailing whitespace", () => {
    expect(parseGitUrl("  git@github.com:owner/repo.git  ")).toBe("owner/repo");
  });
});
