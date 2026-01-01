import { formatDateShort, formatTimeOnly } from "@/lib/format";
import { useAnimationStore } from "@/lib/stores/animation-store";
import { AnimatePresence, motion } from "motion/react";

type Props = {
  simTimeMs: number; // simulation ms from animation start
  realWindowStartDate: Date; // animation window start date (real time)
};

export function TimeDisplay({ simTimeMs, realWindowStartDate }: Props) {
  const isLoadingTrips = useAnimationStore((s) => s.isLoadingTrips);
  const loadError = useAnimationStore((s) => s.loadError);
  const realDisplayTimeMs = realWindowStartDate.getTime() + simTimeMs;

  const showOverlay = isLoadingTrips || loadError;

  return (
    <div className="bg-black/45 backdrop-blur-md px-3 py-1.5 rounded-xl border border-white/10 shadow-[0_0_24px_rgba(0,0,0,0.6)] flex flex-col items-center relative">
      <AnimatePresence mode="wait">
        {isLoadingTrips && (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeInOut" }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <div className="relative">
              <div className="w-[100px] h-[2px] rounded-full bg-white/10" />
              <div
                className="absolute -inset-x-9 -top-5 -bottom-5"
                style={{
                  maskImage:
                    "linear-gradient(to right, transparent 20%, black 35%, black 65%, transparent 80%)",
                  WebkitMaskImage:
                    "linear-gradient(to right, transparent 20%, black 35%, black 65%, transparent 80%)",
                }}
              >
                <motion.div
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-[2px] w-6 rounded-full bg-zinc-100 shadow-[0_0_8px_2px_rgba(255,255,255,0.5)]"
                  animate={{
                    x: [0, 138],
                  }}
                  transition={{
                    duration: 1,
                    repeatDelay: 0.15,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                />
              </div>
            </div>
          </motion.div>
        )}
        {loadError && !isLoadingTrips && (
          <motion.div
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeInOut" }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-red-400 shadow-[0_0_6px_2px_rgba(248,113,113,0.4)]" />
              <span className="text-red-400/90 text-xs font-medium">
                {"Failed to load :("}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <motion.div
        initial={false}
        animate={{
          opacity: showOverlay ? 0 : 1,
          filter: showOverlay ? "blur(8px)" : "blur(0px)",
        }}
        transition={{ duration: 0.3, ease: "easeInOut" }}
        className="flex flex-col items-center"
      >
        <div className="text-white/90 text-xs tracking-wide font-mono">
          {formatDateShort(realDisplayTimeMs)}
        </div>
        <div className="text-xl font-semibold tabular-nums text-white/90 tracking-tight">
          {formatTimeOnly(realDisplayTimeMs)}
        </div>
      </motion.div>
    </div>
  );
}
