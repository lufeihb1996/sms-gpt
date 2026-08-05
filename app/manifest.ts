import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "验证码助手",
    short_name: "验证码助手",
    description: "美国号码自动收码与订单追踪",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#070b16",
    theme_color: "#070b16",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/app-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/app-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
