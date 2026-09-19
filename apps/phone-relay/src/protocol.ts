export function isRoomId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function randomChallenge(): string {
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % 1_000_000);
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return (buffer[0] % 1_000_000).toString().padStart(6, "0");
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

export async function secretsEqual(
  candidate: string,
  expected: string,
): Promise<boolean> {
  if (candidate.length > 512 || expected.length > 512) return false;
  const [candidateHash, expectedHash] = await Promise.all([
    sha256Hex(candidate),
    sha256Hex(expected),
  ]);
  let mismatch = candidateHash.length ^ expectedHash.length;
  for (let index = 0; index < expectedHash.length; index += 1) {
    mismatch |=
      (candidateHash.charCodeAt(index) || 0) ^ expectedHash.charCodeAt(index);
  }
  return mismatch === 0;
}

export function parseOwnerOrigins(value: string | undefined): Set<string> | null {
  const origins = new Set<string>(["http://127.0.0.1:5173"]);
  if (!value?.trim()) return origins;

  for (const entry of value.split(",")) {
    const candidate = entry.trim();
    if (!candidate || candidate.includes("*")) return null;
    try {
      const url = new URL(candidate);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.origin !== candidate
      ) {
        return null;
      }
      origins.add(candidate);
    } catch {
      return null;
    }
  }
  return origins;
}

export function isAllowedAssetPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/phone") return true;
  if (!/^\/assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pathname)) {
    return false;
  }
  return !pathname.split("/").includes("..");
}
