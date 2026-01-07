"use client";

import { Kbd } from "@/components/ui/kbd";
import { COLORS, DEFAULT_SPEEDUP, SIM_BATCH_SIZE_MS } from "@/lib/config";
import { cn } from "@/lib/utils";
import { ArrowLeft, Coffee, Github } from "lucide-react";
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const ArrowIcon = ({ color, showTrail = false }: { color: readonly [number, number, number]; showTrail?: boolean }) => {
  const colorRgb = `rgb(${color.join(", ")})`;
  const gradientId = `trail-${color.join("-")}`;
  return (
    <svg
      width="100"
      height="100"
      viewBox="30 -5 70 70"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0 size-3.5 overflow-visible"
    >
      <defs>
        <linearGradient id={gradientId} x1="63.4105" y1="31.2322" x2="63.4105" y2="137.967" gradientUnits="userSpaceOnUse">
          <stop stopColor={colorRgb} />
          <stop offset="0.817308" stopColor={colorRgb} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Trail */}
      <motion.rect
        x="52.4727"
        y="31.2322"
        width="21.8756"
        transform="rotate(45 52.4727 31.2322)"
        fill={`url(#${gradientId})`}
        initial={{ height: 0, opacity: 0 }}
        animate={{
          height: showTrail ? 106.735 : 0,
          opacity: showTrail ? 1 : 0
        }}
        transition={{
          height: { duration: showTrail ? 0.3 : 0.2, ease: "easeOut" },
          opacity: { duration: showTrail ? 0.15 : 0.25, ease: "easeOut" }
        }}
      />
      {/* Arrow */}
      <path
        d="M90.3143 6.98712C90.609 6.86031 90.9358 6.82533 91.2521 6.88673C91.5684 6.94813 91.8596 7.10308 92.088 7.33146C92.3164 7.55983 92.4713 7.85108 92.5327 8.16738C92.5941 8.48368 92.5591 8.81042 92.4323 9.10518L71.5583 60.8878C71.431 61.2027 71.2075 61.4687 70.9194 61.6482C70.6314 61.8276 70.2934 61.9113 69.9536 61.8874C69.6137 61.8635 69.2892 61.7333 69.0262 61.5151C68.7631 61.297 68.5748 61.002 68.4879 60.6721L63.292 40.8028C62.9995 39.6801 62.4121 38.6541 61.5911 37.8313C60.77 37.0086 59.7452 36.4191 58.6231 36.1242L38.7473 30.9315C38.4174 30.8447 38.1225 30.6564 37.9043 30.3933C37.6861 30.1302 37.5559 29.8057 37.532 29.4658C37.5081 29.126 37.5918 28.7881 37.7713 28.5C37.9507 28.212 38.2167 27.9884 38.5316 27.8611L90.3143 6.98712Z"
        fill={colorRgb}
        stroke={colorRgb}
        strokeWidth="6.45837"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

const LegendItem = ({ color, label, showTrailOnHover = true, glowIntensity = "normal" }: { color: readonly [number, number, number]; label: string; showTrailOnHover?: boolean; glowIntensity?: "normal" | "intense" }) => {
  const [isHovered, setIsHovered] = useState(false);
  const glowFilter = glowIntensity === "intense"
    ? `drop-shadow(0 0 5px rgba(${color.join(", ")}, 0.8)) drop-shadow(0 0 7px rgba(${color.join(", ")}, 0.6))`
    : `drop-shadow(0 0 8px rgb(${color.join(", ")}))`;
  return (
    <span
      className="group flex items-center gap-1.5 cursor-default"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span
        className={cn(
          "transition-[filter] duration-200 transform-gpu",
          isHovered ? "[will-change:filter]" : ""
        )}
        style={{ filter: isHovered ? glowFilter : "none" }}
      >
        <ArrowIcon color={color} showTrail={showTrailOnHover && isHovered} />
      </span>
      <span>{label}</span>
    </span>
  );
};

const XIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="currentColor"
    className={className}
  >
    <path d="M12.6.75h2.454l-5.36 6.142L16 15.25h-4.937l-3.867-5.07-4.425 5.07H.316l5.733-6.57L0 .75h5.063l3.495 4.633L12.601.75Zm-.86 13.028h1.36L4.323 2.145H2.865z" />
  </svg>
);

export default function AboutPage() {
  const router = useRouter();

  // Esc key handler to go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        router.replace("/");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router]);

  return (
    <div className="min-h-dvh bg-background font-mono">
      <main className="max-w-152 mx-auto px-6 py-12 md:py-24">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="flex items-center gap-0.5 group mb-8 md:fixed md:top-6 md:left-6 md:mb-0"
        >
          <ArrowLeft className="size-4 text-white/50 group-hover:text-white transition-colors" />
          <Kbd className="bg-transparent text-white/50 group-hover:text-white transition-colors">
            Esc
          </Kbd>
        </a>
        <h1 className="text-3xl font-semibold text-zinc-100 mb-8">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" className="inline-flex items-center gap-2.5 hover:text-white transition-colors">
            <img src="/icon.svg" alt="" width={30} height={30} />
            <span>bikemap.nyc</span>
          </a>
        </h1>

        <h2 className="text-lg font-medium text-white mb-6">About</h2>

        <div className="space-y-6 text-zinc-400">
          <p>
            bikemap.nyc is a visualization of the entire history of{" "}
            <a
              href="https://citibikenyc.com"
              className="text-zinc-300 font-medium hover:text-zinc-100 underline underline-offset-4"
            >
              Citi Bike
            </a>
            , the largest bike-sharing system in the US.
          </p>

          <p>
            Each moving arrow represents a real bike ride, based on anonymized{" "}
            <a
              href="https://citibikenyc.com/system-data"
              className="text-zinc-300 font-medium hover:text-zinc-100 underline underline-offset-4"
            >
              historical system data
            </a>{" "}
            {`published by Lyft. The animation plays at ${DEFAULT_SPEEDUP}x normal speed and covers 291.2 million trips in New York City since 2013.`}
          </p>

          <p>
            If you have ever used Citi Bike, you are part of the art. Use your Citi Bike receipt to find your ride.
          </p>

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <LegendItem color={COLORS.electric} label="E-bike" />
            <LegendItem color={COLORS.classic} label="Classic bike" />
            <LegendItem color={COLORS.fadeIn} label="Bike unlocked" showTrailOnHover={false} glowIntensity="intense" />
            <LegendItem color={COLORS.fadeOut} label="Bike docked" showTrailOnHover={false} glowIntensity="intense" />
          </div>

          <hr className="border-white/10" />

          <h2 className="text-lg font-medium text-white">Limitations</h2>

          <p>
            The data only contains the start and end station for each trip, but
            does not contain the full path. Route geometries are computed for each (start station, end station) pair using the shortest path from{" "}
            <a
              href="https://project-osrm.org/"
             
              className="text-zinc-300 font-medium hover:text-zinc-100 underline underline-offset-4"
            >
              OSRM
            </a>
            .
          </p>

          <p>
            This means that the computed routes are directionally correct
            but inexact. Trips that start and end at the same station are
            filtered out since the route geometry is ambiguous.
          </p>

          <hr className="border-white/10" />

          <h2 className="text-lg font-medium text-white">Technical Details</h2>

          <ul className="list-disc list-inside space-y-3">
            <li>
              <span className="font-medium text-zinc-300">No backend</span> —
              Processed data is stored in Apache Parquet files and queried by DuckDB WASM directly in the browser.
            </li>
            <li>
              <span className="font-medium text-zinc-300">GPU rendering</span> —
              Deck.gl is cracked and makes it possible to render thousands of concurrent bikes with the GPU.
            </li>
            <li>
              <span className="font-medium text-zinc-300">Worker threads</span> —
              Heavy precomputation is done on Web Workers to offload CPU load from the JS main thread.
            </li>
            <li>
              <span className="font-medium text-zinc-300">Continuous streaming</span> —
              Trips load incrementally and invisibly in {SIM_BATCH_SIZE_MS / 60000}-minute batches.
            </li>
          </ul>

          <hr className="border-white/10" />

          <h2 className="text-lg font-medium text-white">Why</h2>

          <p>
            {"I built this project because I think it is cool and beautiful... and I was "}
            <a
              href="https://x.com/freemanjiangg/status/1996111445642096920"
              className="text-zinc-300 font-medium hover:text-zinc-100 underline underline-offset-4"
            >
              procrastinating
            </a>
            {" my exams."}
          </p>

          <p>
            I&apos;m open-sourcing the entire data processing pipeline and visualization code at {" "}
            <a
              href="https://github.com/freeman-jiang/bikemap.nyc"
             
              className="inline-flex items-baseline gap-1 text-zinc-300 font-medium hover:text-zinc-100 border-b border-current pb-px"
            >
              <Github className="size-4 self-center" />
              freeman-jiang/bikemap.nyc
            </a>.
          </p>

          <p>
             {"I hope to keep this project running indefinitely, but I'm paying for Mapbox and hosting costs out of pocket. If you'd like to support me, please consider "}
            <a
              href="https://buymeacoffee.com/freemanjiang"
             
              className="inline-flex items-baseline gap-1 text-zinc-300 font-medium hover:text-zinc-100 border-b border-current pb-px"
            >
              <Coffee className="size-4 self-center" />
              buying me a coffee
            </a>
            !
          </p>

          <hr className="border-white/10" />

          <p className="flex items-center gap-2">
            <a
              href="https://github.com/freeman-jiang"
             
              className="inline-flex items-center gap-1.5 text-white/70 hover:text-white transition-colors border-b border-current pb-0.5"
            >
              <Github className="size-4" />
              freeman-jiang
            </a>
            <span className="text-white/30">·</span>
            <a
              href="https://x.com/freemanjiangg"
             
              className="inline-flex items-center gap-1.5 text-white/70 hover:text-white transition-colors border-b border-current pb-0.5"
            >
              <XIcon className="size-3.5" />
              @freemanjiangg
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
