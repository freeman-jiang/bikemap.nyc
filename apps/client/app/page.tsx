import { BikeMap } from "@/components/BikeMap";
import { Search } from "@/components/Search";

export default function Home() {
  return (
    <div className="h-screen w-screen">
      <BikeMap />
      <Search />
    </div>
  );
}
