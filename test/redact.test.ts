import { describe, expect, test } from "bun:test";
import { redact } from "../src/redact.ts";

// All secrets below are FAKE, generated for this test only. None are live credentials.

describe("redact: secret patterns are caught", () => {
  // Fake secrets are assembled from fragments at runtime so no contiguous,
  // scannable credential literal exists in this source file. That keeps GitHub
  // push protection quiet while still exercising the redaction patterns on the
  // full assembled value.

  test("OpenAI-style sk- key", () => {
    const key = "sk-" + "FAKE1234567890ABCDEFGHIJ";
    const out = redact(`key is ${key} do not share`);
    expect(out).not.toContain(key);
    expect(out).toContain("«redacted:");
  });

  test("OpenRouter sk-or-v1- key", () => {
    const key = "sk-or-" + "v1-0123456789abcdef0123456789abcdef";
    const out = redact(`OPENROUTER_API_KEY=${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("«redacted:openrouter»");
  });

  test("Google API key (AIza...)", () => {
    const key = "AIza" + "SyFAKE1234567890ABCDEFGHIJKLMNOPQRSTU";
    const out = redact(`using ${key} for the maps call`);
    expect(out).not.toContain(key);
    expect(out).toContain("«redacted:googleapikey»");
  });

  test("nvidia nvapi- key", () => {
    const key = "nvapi-" + "FAKE1234567890ABCDEFGHIJKLMNOPQRSTUV";
    const out = redact(`export NVIDIA_KEY=${key}`);
    expect(out).toContain("«redacted:nvidia»");
  });

  test("Google OAuth AQ. token", () => {
    const key = "AQ." + "Ab8RNfakeexampletoken1234567890XYZ";
    const out = redact(`refresh token: ${key}`);
    expect(out).toContain("«redacted:googleoauth»");
  });

  test("GitHub ghp_ token", () => {
    const key = "ghp_" + "FAKE1234567890FAKE1234567890FAKE12";
    const out = redact(`git remote set-url origin https://${key}@github.com/x/y.git`);
    expect(out).not.toContain(key);
    expect(out).toContain("«redacted:githubtoken»");
  });

  test("Slack xoxb- token", () => {
    const key = "xox" + "b-111111111111-222222222222-FAKEfakeFAKEfakeFAKEfake";
    const out = redact(`SLACK_BOT_TOKEN=${key}`);
    expect(out).toContain("«redacted:slacktoken»");
  });

  test("JWT-looking eyJ... token", () => {
    const jwt = "eyJ" + "hbGciOiJIUzI1NiJ9." + "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0.FAKEsignaturefakefakefakefake";
    const out = redact(`session cookie: ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("«redacted:jwt»");
  });

  test("Authorization: Bearer header value", () => {
    const token = "sk-or-" + "v1-DEADBEEFDEADBEEFDEADBEEFDEADBEEF";
    const out = redact(`Authorization: Bearer ${token}`);
    expect(out).not.toContain("DEADBEEF");
    expect(out).toContain("«redacted:");
    expect(out.startsWith("Authorization: Bearer")).toBe(true);
  });

  test("generic api_key assignment", () => {
    const out = redact('api_key = "FAKESECRET1234567890zz"');
    expect(out).not.toContain("FAKESECRET1234567890zz");
    expect(out).toContain("«redacted:apikey»");
  });

  test("generic password assignment", () => {
    const out = redact("password: hunter2000");
    expect(out).not.toContain("hunter2000");
    expect(out).toContain("«redacted:apikey»");
  });

  test("never throws and returns the input unchanged when there is nothing to redact", () => {
    expect(redact(null)).toBe("");
    expect(redact(undefined)).toBe("");
    expect(redact("")).toBe("");
  });
});

describe("redact: ordinary prose and code are left alone", () => {
  test("plain sentence", () => {
    expect(redact("the bigquery column fix")).toBe("the bigquery column fix");
  });

  test("camelCase identifier with no digits", () => {
    const s = "totalRecallDatabaseConnectionManager handles retries";
    expect(redact(s)).toBe(s);
  });

  test("git commit hash (hex only, low entropy under the mixed-class rule)", () => {
    const s = "fixed in commit abc123def4567890abc123def4567890abc12345";
    expect(redact(s)).toBe(s);
  });

  test("prose using 'secret' as an ordinary word before a colon", () => {
    const s = "design secret: keep it simple";
    expect(redact(s)).toBe(s);
  });

  test("prose mentioning 'token' without an assignment", () => {
    const s = "the rate limiter uses a token bucket algorithm";
    expect(redact(s)).toBe(s);
  });

  test("file path is not swept into the entropy pass", () => {
    const s = "/Users/sharathschandra/playground/total-recall/src/store/db.ts";
    expect(redact(s)).toBe(s);
  });

  // MAJOR regression: the high-entropy catch-all was removed because on real data it masked
  // structural metadata (UUIDs, tool-use ids, git SHAs), not secrets, degrading search recall.
  test("a canonical UUID is not redacted", () => {
    const s = "session id 123e4567-e89b-12d3-a456-426614174000 started";
    expect(redact(s)).toBe(s);
  });

  test("a 40-char git SHA is not redacted", () => {
    const s = "fixed in commit 8f14e45fceea167a5a36dedd4bea2543ea23f9a1 on main";
    expect(redact(s)).toBe(s);
  });

  test("a tool-use-id value is not redacted", () => {
    const s = 'tool_use_id: "toolu_01A2b3C4d5E6f7G8h9J0k1L2"';
    expect(redact(s)).toBe(s);
  });
});
