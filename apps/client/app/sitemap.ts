import { SITE_ORIGIN } from "@/lib/site";
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/about"].map((path) => ({ url: new URL(path, SITE_ORIGIN).href }));
}
