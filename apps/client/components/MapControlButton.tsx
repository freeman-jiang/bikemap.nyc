import type { ReactNode } from "react";

interface MapControlButtonProps {
  onClick: () => void;
  children: ReactNode;
}

export const MapControlButton = ({ onClick, children }: MapControlButtonProps) => {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 bg-black/45 hover:bg-black/55 hover:scale-[1.02] active:scale-95 text-white/90 text-sm font-medium pl-2 pr-3 py-1.5 rounded-full border border-white/10 backdrop-blur-md transition-all duration-200 ease-out shadow-[0_0_20px_rgba(0,0,0,0.6)] hover:duration-100 active:duration-200 outline-none"
    >
      {children}
    </button>
  );
};
