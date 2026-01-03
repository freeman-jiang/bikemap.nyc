import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://bikemap.nyc"),
  title: "bikemap.nyc",
  description:
    "Visualization of the entire history of Citi Bike, the largest bike-sharing system in the US.",
  keywords: [
    "Citi Bike",
    "NYC bike visualization",
    "bike share",
    "data visualization",
    "New York City",
    "bikemap.nyc",
  ],
  authors: [{ name: "Freeman Jiang", url: "https://freemanjiang.com" }],
  creator: "Freeman Jiang",
  openGraph: {
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "bikemap.nyc",
    description:
      "Visualization of the entire history of Citi Bike, the largest bike-sharing system in the US.",
    creator: "@freemanjiangg",
    images: ["/opengraph-image.png"],
  },
  };

export const viewport: Viewport = {
  themeColor: "#09090b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${geistMono.variable} font-sans antialiased dark`}
      >
        {children}
      </body>
    </html>
  );
}
