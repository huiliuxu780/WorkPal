import brand from "./brand.json" with { type: "json" };

/** Public product identity. Internal package, environment and persisted keys stay unchanged. */
export const PRODUCT_BRAND = brand;
export const PRODUCT_USER_AGENT = `${brand.name}/0.1 (+${brand.links.repository})`;

export function brandedAsset(path: string): string {
  return `${path}?v=${encodeURIComponent(brand.logo.cacheVersion)}`;
}

export function productWebManifest() {
  return {
    name: brand.name,
    short_name: brand.name,
    description: brand.description,
    start_url: "/",
    display: "standalone",
    background_color: "#050506",
    theme_color: "#050506",
    icons: [
      { src: brandedAsset(brand.logo.icon192), sizes: "192x192", type: "image/png" },
      { src: brandedAsset(brand.logo.icon512), sizes: "512x512", type: "image/png" },
    ],
  };
}
