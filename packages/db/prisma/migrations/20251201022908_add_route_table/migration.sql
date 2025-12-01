-- CreateTable
CREATE TABLE "Route" (
    "startStationId" TEXT NOT NULL,
    "endStationId" TEXT NOT NULL,
    "geometry" TEXT NOT NULL,
    "distance" REAL NOT NULL,
    "duration" REAL NOT NULL,

    PRIMARY KEY ("startStationId", "endStationId")
);
