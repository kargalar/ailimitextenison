const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  formatCodexRefreshError,
  getCodexAccessTokenExpiry,
  getJwtExpiration,
  normalizeCodexTokenExpiry,
} = require("../out/token-utils.js");

function makeJwt(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  return `header.${encodedPayload}.signature`;
}

test("getJwtExpiration returns exp as milliseconds", () => {
  assert.equal(getJwtExpiration(makeJwt({ exp: 1_800_000_000 })), 1_800_000_000_000);
});

test("getJwtExpiration ignores invalid and missing exp claims", () => {
  assert.equal(getJwtExpiration("not-a-jwt"), undefined);
  assert.equal(getJwtExpiration(makeJwt({ exp: "later" })), undefined);
});

test("Codex expiry is taken from its access token claims", () => {
  const accessToken = makeJwt({ exp: 1_800_000_000 });
  const idToken = makeJwt({ exp: 1_799_000_000 });

  assert.equal(getCodexAccessTokenExpiry(accessToken), 1_800_000_000_000);
  assert.notEqual(
    getCodexAccessTokenExpiry(accessToken),
    getJwtExpiration(idToken),
  );
});

test("normalizeCodexTokenExpiry repairs an outdated saved expiration", () => {
  const accessToken = makeJwt({ exp: 1_800_000_000 });

  assert.equal(
    normalizeCodexTokenExpiry(accessToken, 1_700_000_000_000),
    1_800_000_000_000,
  );
});

test("formatCodexRefreshError explains rejected sessions without leaking raw response", () => {
  assert.equal(
    formatCodexRefreshError(
      401,
      JSON.stringify({ error: "refresh_token_reused" }),
    ),
    "Codex refresh token was rejected (401): refresh_token_reused. Re-add this account with OAuth to refresh its session.",
  );
  assert.equal(
    formatCodexRefreshError(401, "unexpected upstream response"),
    "Codex refresh token was rejected (401). Re-add this account with OAuth to refresh its session.",
  );
});
