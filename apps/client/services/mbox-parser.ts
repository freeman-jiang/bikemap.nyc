import { UserRide, BikeType } from '@/lib/stores/user-rides-store'

/**
 * Parse Citi Bike ride receipts from an mbox file content.
 * 
 * The mbox format separates emails with lines starting with "From ".
 * Each email is in quoted-printable encoding with HTML content.
 */

interface ParseResult {
  rides: UserRide[]
  errors: string[]
  totalEmails: number
}

/**
 * Decode quoted-printable encoding commonly used in emails.
 * Handles soft line breaks (=\n) and encoded characters (=XX).
 */
function decodeQuotedPrintable(text: string): string {
  // Remove soft line breaks (= at end of line)
  let decoded = text.replace(/=\r?\n/g, '')
  
  // Decode =XX hex sequences
  decoded = decoded.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16))
  })
  
  return decoded
}

/**
 * Extract text content between HTML tags using regex.
 * This is a simple approach that works for the structured Citi Bike emails.
 */
function extractText(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern)
  if (!match) return null
  
  // Clean up the extracted text
  let text = match[1]
    .replace(/<[^>]+>/g, ' ')  // Remove HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')    // Remove numeric entities
    .replace(/\s+/g, ' ')      // Normalize whitespace
    .trim()
  
  return text || null
}

/**
 * Parse the date/time from the email preheader.
 * Format: "NOVEMBER 15, 2025 AT 6:42 PM"
 */
function parseDateTime(html: string): { date: Date; startTime: string } | null {
  // Look for the date pattern in the preheader
  const datePattern = /([A-Z]+)\s+(\d{1,2}),\s+(\d{4})\s+AT\s+(\d{1,2}:\d{2}\s*[AP]M)/i
  const match = html.match(datePattern)
  
  if (!match) return null
  
  const [, month, day, year, time] = match
  const startTime = time.toLowerCase()
  
  // Parse into a Date object
  const monthMap: Record<string, number> = {
    'january': 0, 'february': 1, 'march': 2, 'april': 3,
    'may': 4, 'june': 5, 'july': 6, 'august': 7,
    'september': 8, 'october': 9, 'november': 10, 'december': 11
  }
  
  const monthNum = monthMap[month.toLowerCase()]
  if (monthNum === undefined) return null
  
  // Parse time (e.g., "6:42 PM")
  const timeMatch = time.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i)
  if (!timeMatch) return null
  
  let hours = parseInt(timeMatch[1], 10)
  const minutes = parseInt(timeMatch[2], 10)
  const isPM = timeMatch[3].toUpperCase() === 'PM'
  
  if (isPM && hours !== 12) hours += 12
  if (!isPM && hours === 12) hours = 0
  
  const date = new Date(parseInt(year, 10), monthNum, parseInt(day, 10), hours, minutes)
  
  return { date, startTime }
}

/**
 * Parse total cost from preheader.
 * Format: "Bike ride total: $2.45 Visa"
 */
function parseTotalCost(html: string): number | null {
  const pattern = /Bike ride total:\s*\$([0-9]+\.?\d*)/i
  const match = html.match(pattern)
  return match ? parseFloat(match[1]) : null
}

/**
 * Determine bike type from the image URL in the email.
 * - "citi_bike_cosmo" = ebike
 * - "motivate_bike_classic" = classic
 */
function parseBikeType(html: string): BikeType {
  if (html.includes('citi_bike_cosmo')) {
    return 'ebike'
  }
  return 'classic'
}

/**
 * Extract bike ID from the email.
 * It appears in a styled pill/badge element.
 */
function parseBikeId(html: string): string | null {
  // The bike ID appears after the bike image in a specific td element
  // Pattern: background="pill_background.png"...>BIKE_ID<
  const pattern = /pill_background\.png[^>]*>[\s\n]*(\d+)[\s\n]*</i
  const match = html.match(pattern)
  return match ? match[1] : null
}

/**
 * Parse start and end stations with times.
 * The email structure has stations with Start/End labels.
 */
function parseStations(html: string): { 
  startStation: string
  endStation: string
  startTime: string
  endTime: string
} | null {
  // Find the "Your Trip" section and extract station info
  // Station pattern: station name followed by Start/End label and time
  
  // Start station pattern - look for Start label
  const startPattern = /font-size:\s*17px[^>]*>[\s\n]*([^<]+)[\s\n]*<\/td>[\s\n]*<td[^>]*>[\s\n]*<span[^>]*>Start<\/span>[\s\n]*<br>[\s\n]*(\d{1,2}:\d{2}\s*[ap]m)/i
  const startMatch = html.match(startPattern)
  
  // End station pattern - look for End label  
  const endPattern = /font-size:\s*17px[^>]*>[\s\n]*([^<]+)[\s\n]*<\/td>[\s\n]*<td[^>]*>[\s\n]*<span[^>]*>End<\/span>[\s\n]*<br>[\s\n]*(\d{1,2}:\d{2}\s*[ap]m)/i
  const endMatch = html.match(endPattern)
  
  if (!startMatch || !endMatch) return null
  
  return {
    startStation: startMatch[1].replace(/&amp;/g, '&').trim(),
    endStation: endMatch[1].replace(/&amp;/g, '&').trim(),
    startTime: startMatch[2].toLowerCase(),
    endTime: endMatch[2].toLowerCase()
  }
}

/**
 * Parse duration in minutes from cost breakdown.
 * Patterns:
 * - "Ebike ride ($0.25 per min for 9 min)"
 * - "$0.24 per min (24 min)"
 */
function parseDuration(html: string): number | null {
  // Try ebike pattern first
  const ebikePattern = /Ebike ride[^)]*for\s+(\d+)\s+min/i
  const ebikeMatch = html.match(ebikePattern)
  if (ebikeMatch) {
    return parseInt(ebikeMatch[1], 10)
  }
  
  // Try classic pattern
  const classicPattern = /\$[\d.]+\s+per min\s+\((\d+)\s+min\)/i
  const classicMatch = html.match(classicPattern)
  if (classicMatch) {
    return parseInt(classicMatch[1], 10)
  }
  
  return null
}

/**
 * Extract receipt number as the ride ID.
 * Format: "Receipt # 1973425678559627094"
 */
function parseReceiptId(html: string): string | null {
  const pattern = /Receipt\s*#\s*(\d+)/i
  const match = html.match(pattern)
  return match ? match[1] : null
}

/**
 * Parse a single email into a UserRide object.
 */
function parseEmail(emailContent: string): UserRide | null {
  // Decode quoted-printable encoding
  const html = decodeQuotedPrintable(emailContent)
  
  // Extract required fields
  const dateTime = parseDateTime(html)
  if (!dateTime) return null
  
  const stations = parseStations(html)
  if (!stations) return null
  
  const cost = parseTotalCost(html) ?? 0
  const bikeType = parseBikeType(html)
  const bikeId = parseBikeId(html)
  const duration = parseDuration(html)
  const receiptId = parseReceiptId(html)
  
  // Generate an ID if receipt number not found
  const id = receiptId ?? `${dateTime.date.getTime()}-${stations.startStation.slice(0, 10)}`
  
  return {
    id,
    date: dateTime.date,
    startStation: stations.startStation,
    endStation: stations.endStation,
    startTime: stations.startTime,
    endTime: stations.endTime,
    durationMinutes: duration ?? 0,
    bikeType,
    bikeId,
    cost,
    // Route geometry (to be resolved after parsing)
    routeGeometry: null,
    routeDistance: null,
    startLat: null,
    startLng: null,
    endLat: null,
    endLng: null,
  }
}

/**
 * Split mbox content into individual emails.
 * Emails are separated by lines starting with "From " (with a space).
 */
function splitMbox(content: string): string[] {
  // Split on the mbox separator pattern
  // Each email starts with "From <id>@xxx <timestamp>"
  const emails = content.split(/^From \S+@\S+ .+$/m)
  
  // Filter out empty entries
  return emails.filter(email => email.trim().length > 0)
}

/**
 * Main parser function.
 * Takes raw mbox file content and returns parsed rides.
 */
export function parseMbox(content: string): ParseResult {
  const emails = splitMbox(content)
  const rides: UserRide[] = []
  const errors: string[] = []
  
  for (let i = 0; i < emails.length; i++) {
    try {
      const ride = parseEmail(emails[i])
      if (ride) {
        rides.push(ride)
      } else {
        // Only log if email seems to be a ride receipt (has "Ride Receipt" subject)
        if (emails[i].includes('Subject: Ride Receipt')) {
          errors.push(`Email ${i + 1}: Failed to parse ride data`)
        }
      }
    } catch (err) {
      errors.push(`Email ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }
  
  // Sort rides by date (newest first)
  rides.sort((a, b) => b.date.getTime() - a.date.getTime())
  
  return {
    rides,
    errors,
    totalEmails: emails.length
  }
}

/**
 * Parse multiple mbox files and combine results.
 */
export function parseMboxFiles(files: { filename: string; content: string }[]): ParseResult {
  const allRides: UserRide[] = []
  const allErrors: string[] = []
  let totalEmails = 0
  
  for (const file of files) {
    const result = parseMbox(file.content)
    allRides.push(...result.rides)
    allErrors.push(...result.errors.map(e => `${file.filename}: ${e}`))
    totalEmails += result.totalEmails
  }
  
  // Deduplicate by ID (in case same ride appears in multiple exports)
  const uniqueRides = Array.from(
    new Map(allRides.map(r => [r.id, r])).values()
  )
  
  // Sort by date (newest first)
  uniqueRides.sort((a, b) => b.date.getTime() - a.date.getTime())
  
  return {
    rides: uniqueRides,
    errors: allErrors,
    totalEmails
  }
}
