import { brandedAsset, PRODUCT_BRAND, productWebManifest } from "@rakazo/contracts/brand";
import type { Plugin } from "vite";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/** One configuration supplies HTML metadata and both dev/build installation manifests. */
export function productBrandAssets(): Plugin {
  const manifest = () => JSON.stringify(productWebManifest(), null, 2);
  return {
    name: "product-brand-assets",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const values: Record<string, string> = {
          PRODUCT_NAME: PRODUCT_BRAND.name,
          PRODUCT_DESCRIPTION: PRODUCT_BRAND.description,
          PRODUCT_FAVICON: brandedAsset(PRODUCT_BRAND.logo.favicon),
          PRODUCT_LOGO: brandedAsset(PRODUCT_BRAND.logo.src),
          PRODUCT_APPLE_ICON: brandedAsset(PRODUCT_BRAND.logo.appleTouchIcon),
          PRODUCT_MANIFEST: brandedAsset("/site.webmanifest"),
        };
        return html.replace(/__([A-Z_]+)__/g, (match, key: string) =>
          values[key] === undefined ? match : escapeHtml(values[key]),
        );
      },
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== "/site.webmanifest") return next();
        response.setHeader("content-type", "application/manifest+json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(manifest());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "site.webmanifest", source: manifest() });
    },
  };
}
