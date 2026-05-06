// Web Crypto helpers — work in Cloudflare Workers.

export function randomDigits(n: number): string {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < n; i++) out += (buf[i] % 10).toString();
  return out;
}

/**
 * SHA-256 of (code || email) — keeps OTP codes from being readable in DB
 * if the table ever leaks. Salting per-email defends against precomputed tables.
 */
export async function hashCode(code: string, email: string): Promise<string> {
  const data = new TextEncoder().encode(`${code}::${email}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}
