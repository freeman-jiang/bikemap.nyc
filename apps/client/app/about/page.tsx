"use client";

import { Kbd } from "@/components/ui/kbd";
import { DEFAULT_SPEEDUP, SIM_BATCH_SIZE_MS } from "@/lib/config";
import { ArrowLeft, Coffee, Github } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

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
      <main className="max-w-2xl mx-auto px-6 py-12 md:py-24">
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
          <a href="/" className="hover:text-white transition-colors">
            bikemap.nyc
          </a>
        </h1>

        <h2 className="text-lg font-medium text-white mb-6">About</h2>

        <div className="space-y-6 text-zinc-400">
          <p>
            bikemap.nyc is a GPU-powered data visualization of{" "}
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
            {`published by Lyft. The animation plays at ${DEFAULT_SPEEDUP}x normal speed and covers 200M+ trips in New York City since 2013.`}
          </p>

          <p>
            If you have ever used Citi Bike, your ride is likely here. Use your Citi Bike receipt to search for and find your ride.
          </p>

          <hr className="border-white/10" />

          <h2 className="text-lg font-medium text-white">Limitations</h2>

          <p>
            The data only contains the start and end station for each trip, but
            does not contain the exact route. Thus,
             route geometries are computed using the shortest path from{" "}
            <a
              href="https://project-osrm.org/"
             
              className="text-zinc-300 font-medium hover:text-zinc-100 underline underline-offset-4"
            >
              OSRM
            </a>
            .
          </p>

          <p>
            This means that the calculated routes are directionally correct
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
            {"There is no economic value for this project except that I think it is cool and beautiful :)"}
          </p>

          <p>
            I&apos;m open-sourcing the entire data processing pipeline and rendering code at {" "}
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
