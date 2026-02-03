"use client"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useUploadStore } from "@/lib/stores/upload-store"
import { useUserRidesStore } from "@/lib/stores/user-rides-store"
import { cn } from "@/lib/utils"
import { parseMboxFiles } from "@/services/mbox-parser"
import JSZip from "jszip"
import { FileArchive, Loader2, Upload, CheckCircle2, XCircle, Bike } from "lucide-react"
import { useCallback, useState } from "react"

type UploadStatus = "idle" | "dragging" | "processing" | "parsing" | "success" | "error"

type MboxResult = {
  filename: string
  content: string
}

type ParseStats = {
  totalRides: number
  totalEmails: number
  errorCount: number
}

export function UploadDialog() {
  const { isOpen, close } = useUploadStore()
  const { addRides } = useUserRidesStore()
  const [status, setStatus] = useState<UploadStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [mboxFiles, setMboxFiles] = useState<MboxResult[]>([])
  const [progress, setProgress] = useState<string>("")
  const [parseStats, setParseStats] = useState<ParseStats | null>(null)

  const resetState = useCallback(() => {
    setStatus("idle")
    setError(null)
    setMboxFiles([])
    setProgress("")
    setParseStats(null)
  }, [])

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      close()
      // Reset state after dialog closes
      setTimeout(resetState, 200)
    }
  }, [close, resetState])

  const processZipFile = useCallback(async (file: File) => {
    setStatus("processing")
    setError(null)
    setProgress("Reading zip file...")

    try {
      const zip = await JSZip.loadAsync(file)
      setProgress("Searching for .mbox files...")

      // Find all .mbox files in the archive
      const mboxEntries: { path: string; file: JSZip.JSZipObject }[] = []
      
      zip.forEach((relativePath, zipEntry) => {
        if (!zipEntry.dir && relativePath.toLowerCase().endsWith(".mbox")) {
          mboxEntries.push({ path: relativePath, file: zipEntry })
        }
      })

      if (mboxEntries.length === 0) {
        setStatus("error")
        setError("No .mbox files found in the archive. Make sure you exported Mail from Google Takeout.")
        return
      }

      setProgress(`Found ${mboxEntries.length} .mbox file(s). Extracting...`)

      // Extract all mbox files
      const results: MboxResult[] = []
      for (const entry of mboxEntries) {
        setProgress(`Extracting ${entry.path}...`)
        const content = await entry.file.async("string")
        results.push({
          filename: entry.path,
          content,
        })
      }

      setMboxFiles(results)
      
      // Parse the mbox files
      setStatus("parsing")
      setProgress("Parsing ride receipts...")
      
      // Use setTimeout to allow UI to update before parsing
      await new Promise(resolve => setTimeout(resolve, 50))
      
      const parseResult = parseMboxFiles(results)
      
      if (parseResult.rides.length === 0) {
        setStatus("error")
        setError("No ride receipts found in the exported emails. Make sure you exported Citi Bike ride receipts.")
        return
      }
      
      // Add rides to store
      addRides(parseResult.rides)
      
      setParseStats({
        totalRides: parseResult.rides.length,
        totalEmails: parseResult.totalEmails,
        errorCount: parseResult.errors.length
      })
      
      setStatus("success")
      setProgress("")
      
      console.log(`Parsed ${parseResult.rides.length} rides from ${parseResult.totalEmails} emails`, {
        errors: parseResult.errors,
        sample: parseResult.rides.slice(0, 3)
      })

    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "Failed to process zip file")
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setStatus("idle")

    const file = e.dataTransfer.files[0]
    if (!file) return

    if (!file.name.toLowerCase().endsWith(".zip")) {
      setStatus("error")
      setError("Please drop a .zip file from Google Takeout")
      return
    }

    processZipFile(file)
  }, [processZipFile])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setStatus("dragging")
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    // Only set to idle if we're leaving the drop zone entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setStatus("idle")
    }
  }, [])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.name.toLowerCase().endsWith(".zip")) {
      setStatus("error")
      setError("Please select a .zip file from Google Takeout")
      return
    }

    processZipFile(file)
  }, [processZipFile])

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import Your Rides</DialogTitle>
          <DialogDescription>
            Upload your Google Takeout export to find your Citi Bike trips.
          </DialogDescription>
        </DialogHeader>

        {/* Drop Zone */}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={cn(
            "relative flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed p-8 transition-colors",
            status === "dragging" && "border-white/50 bg-white/5",
            status === "idle" && "border-white/20 hover:border-white/30 hover:bg-white/[0.02]",
            status === "processing" && "border-blue-500/50 bg-blue-500/5",
            status === "success" && "border-green-500/50 bg-green-500/5",
            status === "error" && "border-red-500/50 bg-red-500/5"
          )}
        >
          {status === "idle" && (
            <>
              <FileArchive className="size-10 text-white/40" />
              <div className="text-center">
                <p className="text-sm text-white/70">
                  Drag & drop your Google Takeout <code className="text-white/90">.zip</code> file
                </p>
                <p className="mt-1 text-xs text-white/40">
                  or click to browse
                </p>
              </div>
              <input
                type="file"
                accept=".zip"
                onChange={handleFileInput}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </>
          )}

          {status === "dragging" && (
            <>
              <Upload className="size-10 text-white/60" />
              <p className="text-sm text-white/70">Drop to upload</p>
            </>
          )}

          {(status === "processing" || status === "parsing") && (
            <>
              <Loader2 className="size-10 text-blue-400 animate-spin" />
              <p className="text-sm text-blue-300">{progress || "Processing..."}</p>
            </>
          )}

          {status === "success" && parseStats && (
            <>
              <CheckCircle2 className="size-10 text-green-400" />
              <div className="text-center">
                <p className="text-sm text-green-300">
                  Found {parseStats.totalRides} ride{parseStats.totalRides !== 1 ? "s" : ""}!
                </p>
                <p className="mt-1 text-xs text-white/50">
                  Parsed from {parseStats.totalEmails} email{parseStats.totalEmails !== 1 ? "s" : ""}
                </p>
                <div className="mt-4 flex items-center justify-center gap-2">
                  <Bike className="size-4 text-white/60" />
                  <span className="text-xs text-white/60">
                    Your rides have been imported
                  </span>
                </div>
                <button
                  onClick={() => {
                    close()
                    setTimeout(resetState, 200)
                  }}
                  className="mt-4 px-4 py-2 text-sm font-medium text-white/90 bg-white/10 hover:bg-white/15 rounded-lg transition-colors"
                >
                  View My Rides
                </button>
              </div>
            </>
          )}

          {status === "error" && (
            <>
              <XCircle className="size-10 text-red-400" />
              <div className="text-center">
                <p className="text-sm text-red-300">{error}</p>
                <button
                  onClick={resetState}
                  className="mt-3 text-xs text-white/50 hover:text-white/70 underline underline-offset-2"
                >
                  Try again
                </button>
              </div>
            </>
          )}
        </div>

        {/* Instructions */}
        <div className="text-xs text-white/40 space-y-2">
          <p className="font-medium text-white/50">How to export from Gmail:</p>
          <ol className="list-decimal list-inside space-y-1 ml-1">
            <li>Go to <a href="https://takeout.google.com" target="_blank" rel="noopener noreferrer" className="text-white/60 hover:text-white/80 underline underline-offset-2">takeout.google.com</a></li>
            <li>Deselect all, then select only &quot;Mail&quot;</li>
            <li>Click &quot;All Mail data included&quot; → filter by label or search</li>
            <li>Export and download the .zip file</li>
          </ol>
        </div>
      </DialogContent>
    </Dialog>
  )
}
