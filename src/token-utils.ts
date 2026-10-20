export function getJwtExpiration(jwt?: string): number | undefined {
  if (!jwt) return undefined;
  const [, encodedPayload] = jwt.split(".");
  if (!encodedPayload) return undefined;

  try {
    const normalized = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(
      Buffer.from(padded, "base64").toString("utf8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

export function getCodexAccessTokenExpiry(
  accessToken?: string,
): number | undefined {
  return getJwtExpiration(accessToken);
}

export function normalizeCodexTokenExpiry(
  accessToken: string,
  storedExpiry?: number,
): number | undefined {
  return getCodexAccessTokenExpiry(accessToken) ?? storedExpiry;
}

export function formatCodexRefreshError(
  status: number,
  responseBody: string,
): string {
  let detail = "";
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    const error =
      typeof parsed.error === "string" ? parsed.error : undefined;
    const description =
      typeof parsed.error_description === "string"
        ? parsed.error_description
        : undefined;
    detail = [error, description].filter(Boolean).join(": ");
  } catch {
    // Ignore unstructured responses to avoid showing arbitrary response content.
  }

  const responseDetail = detail ? `: ${detail}` : "";
  if (status === 401) {
    return `Codex refresh token was rejected (401)${responseDetail}. Re-add this account with OAuth to refresh its session.`;
  }
  return `Codex token refresh failed (${status})${responseDetail}`;
}
