// Preload installs desktopBridge before web code runs, so module-load detection is reliable.
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

// Vite's `base`: empty for a root build, "/some/path" for a bundle served under a sub-path.
const APP_BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** An app path, such as `/pair`, as an address on the page's origin. */
export function appHref(path: string): string {
  return `${APP_BASE_PATH}${path}`;
}

/** A page address's path inside the app, without the sub-path the bundle is served under. */
export function appPathname(pathname: string): string {
  if (APP_BASE_PATH === "" || !`${pathname}/`.startsWith(`${APP_BASE_PATH}/`)) return pathname;
  return pathname.slice(APP_BASE_PATH.length) || "/";
}
