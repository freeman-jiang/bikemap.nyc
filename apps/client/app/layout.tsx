import type { Metadata } from "next";
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
  title: "bikemap.nyc",
  description:
    "bikemap.nyc is a GPU-powered data visualization of 12 years of Citi Bike, New York City's biggest bike-sharing system.",
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
  twitter: {
    card: "summary_large_image",
    title: "bikemap.nyc",
    description:
      "bikemap.nyc is a GPU-powered data visualization of 12 years of Citi Bike, New York City's biggest bike-sharing system.",
    creator: "@freemanjiangg",
  },
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
