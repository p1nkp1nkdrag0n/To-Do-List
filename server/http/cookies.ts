export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (header === undefined || header.trim() === "") {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const component of header.split(";")) {
    const separator = component.indexOf("=");
    if (separator < 0) {
      continue;
    }

    try {
      const name = decodeURIComponent(component.slice(0, separator).trim());
      const value = decodeURIComponent(component.slice(separator + 1).trim());
      if (name !== "" && cookies[name] === undefined) {
        cookies[name] = value;
      }
    } catch {
      // Ignore only the malformed cookie component.
    }
  }
  return cookies;
}
