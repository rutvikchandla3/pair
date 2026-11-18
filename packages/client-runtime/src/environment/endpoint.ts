export * from "@t3tools/shared/advertisedEndpoint";

function basePathPrefix(url: URL): string {
  return url.pathname.replace(/\/+$/, "");
}

/**
 * The server path `pathname` (such as `/api/auth/session`) under `httpBaseUrl`. A base URL with a
 * path is a server mounted under that prefix, for example behind a reverse proxy.
 */
export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = `${basePathPrefix(url)}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

/** Resolves a URL the server returned, whose root-relative paths are relative to the server root. */
export const resolveEnvironmentUrl = (httpBaseUrl: string, serverUrl: string): string => {
  const base = new URL(httpBaseUrl);
  if (!serverUrl.startsWith("/") || serverUrl.startsWith("//")) {
    return new URL(serverUrl, base).toString();
  }
  const url = new URL(serverUrl, base.origin);
  url.pathname = `${basePathPrefix(base)}${url.pathname}`;
  return url.toString();
};

/** A base URL ending in `/` gets the server's `ws` path under it; any other path is the socket itself. */
export const environmentSocketUrl = (wsBaseUrl: string): URL => {
  const url = new URL(wsBaseUrl);
  if (url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}ws`;
  }
  return url;
};
