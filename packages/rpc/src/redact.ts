const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;

/**
 * Keeps provider URLs, which usually embed an API key, out of logs and errors. Every URL in a
 * string is cut down to its scheme and host, and the registered secrets (each full URL, its long
 * path segments and query values, its password) are replaced wherever they appear, since some
 * providers echo the key back in an error message without the URL around it.
 */
export class Redactor {
  readonly #secrets = new Set<string>();

  /** Strings this short are not secrets worth hiding, and replacing them would mangle every message. */
  #add(secret: string): void {
    if (secret.length >= 4) this.#secrets.add(secret);
  }

  register(url: string): void {
    this.#add(url);
    try {
      const parsed = new URL(url);
      this.#add(decodeURIComponent(parsed.password));
      this.#add(decodeURIComponent(parsed.username));
      for (const segment of parsed.pathname.split("/")) {
        if (segment.length >= 8) this.#add(decodeURIComponent(segment));
      }
      for (const value of parsed.searchParams.values()) {
        if (value.length >= 8) this.#add(value);
      }
    } catch {
      // Not a URL: the whole string is already registered.
    }
  }

  redact(text: string): string {
    let out = text.replace(URL_PATTERN, (match) => {
      try {
        const parsed = new URL(match);
        return `${parsed.protocol}//${parsed.host}/<redacted>`;
      } catch {
        return "<redacted-url>";
      }
    });
    // Longest first, so a secret that contains another is removed whole.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      out = out.replaceAll(secret, "<redacted>");
    }
    return out;
  }
}
