// =============================================================================
// Distance Formatting
// =============================================================================

export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m`;
  }
  return `${(meters / 1000).toFixed(1)}km`;
}

// =============================================================================
// Duration Formatting
// =============================================================================

export function formatDurationMinutes(startedAt: Date, endedAt: Date): string {
  const ms = endedAt.getTime() - startedAt.getTime();
  const minutes = Math.round(ms / 60000);
  return `${minutes} min${minutes !== 1 ? "s" : ""}`;
}

// =============================================================================
// Date/Time Formatting
// =============================================================================

// Format date for display (omits year if current year)
export function formatDateTime(date: Date): string {
  const currentYear = new Date().getFullYear();
  const dateYear = date.getFullYear();

  return date.toLocaleString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: dateYear !== currentYear ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Format date with year always included
export function formatDateTimeFull(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Format milliseconds timestamp (NYC timezone)
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });
}
