"use client";

import Link from "next/link";
import { useTelemetry } from "@/context/TelemetryContext";

export default function DashboardOverview() {
  const { telemetry } = useTelemetry();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full font-mono text-sm">

      {/* Top Stats Row */}
      <div className="lg:col-span-12 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-6">
        <div className="border-[2px] border-[var(--color-iron)] bg-black p-4 flex flex-col uppercase">
          <span className="text-[10px] text-[var(--color-silica)] font-bold mb-2">[ TOTAL_FRAMES_ANALYZED ]</span>
          <span className="text-2xl sm:text-3xl font-black text-[var(--color-data)] break-all">{telemetry.scanned.toLocaleString()}</span>
        </div>
        <div className="border-[2px] border-[var(--color-iron)] bg-black p-4 flex flex-col uppercase">
          <span className="text-[10px] text-[var(--color-silica)] font-bold mb-2">[ ANOMALIES_DETECTED ]</span>
          <span className="text-2xl sm:text-3xl font-black text-[var(--color-alert)]">{telemetry.anomalies}</span>
        </div>
        <div className="border-[2px] border-[var(--color-iron)] bg-black p-4 flex flex-col uppercase">
          <span className="text-[10px] text-[var(--color-silica)] font-bold mb-2">[ ONLINE_SENSORS ]</span>
          <span className="text-2xl sm:text-3xl font-black text-[var(--color-data)]">{telemetry.activeNodes}</span>
        </div>
        <div className="border-[2px] border-[var(--color-iron)] bg-black p-4 flex flex-col uppercase">
          <span className="text-[10px] text-[var(--color-silica)] font-bold mb-2">[ AVG_NODE_LATENCY ]</span>
          <span className="text-2xl sm:text-3xl font-black text-[var(--color-data)]">{telemetry.latency}ms</span>
        </div>
      </div>

      {/* Main Action Modules */}
      <div className="lg:col-span-8 grid grid-rows-3 gap-6">
        <Link href="/dashboard/live" className="border-[2px] border-[var(--color-iron)] bg-black p-6 hover:bg-[var(--color-alert)] hover:border-[var(--color-alert)] transition-none group cursor-crosshair flex flex-col relative overflow-hidden">
          <div className="absolute inset-0 bg-[linear-gradient(rgba(51,51,51,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(51,51,51,0.5)_1px,transparent_1px)] bg-[size:32px_32px] opacity-20 pointer-events-none group-hover:bg-[linear-gradient(rgba(0,0,0,0.2)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.2)_1px,transparent_1px)]" />

          <div className="flex justify-between items-start mb-auto relative z-10 w-full group-hover:text-black text-[var(--color-alert)]">
            <span className="font-bold border-b border-current pb-1 uppercase tracking-widest">[ INITIALIZE_MATRIX ]</span>
            <div className="w-3 h-3 bg-current animate-pulse" />
          </div>
          <div className="relative z-10 group-hover:text-black">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-black uppercase tracking-tighter mb-2">Live Stream<br />Tracking</h2>
            <p className="text-xs uppercase font-bold max-w-md opacity-80">
              CONNECT HARDWARE CAMERAS. DISTRIBUTE INFERENCE ACROSS MULTIPLE SENSORS WITH SUBLIMINAL LATENCY.
            </p>
          </div>
        </Link>

        <Link href="/dashboard/upload" className="border-[2px] border-[var(--color-iron)] bg-black p-6 hover:bg-[var(--color-data)] hover:border-[var(--color-data)] transition-none group cursor-crosshair flex flex-col relative overflow-hidden text-[var(--color-data)] hover:text-black">
          <div className="flex justify-between items-start mb-auto relative z-10 w-full">
            <span className="font-bold border-b border-current pb-1 uppercase tracking-widest">[ INGEST_FORENSICS ]</span>
          </div>
          <div className="relative z-10">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-black uppercase tracking-tighter mb-2">Pre-Recorded<br />Analysis</h2>
            <p className="text-xs uppercase font-bold max-w-md opacity-80">
              UPLOAD BULK CCTV ARCHIVES. RAPID ANALYSIS WITH FRAME-LEVEL TIMESTAMPS AND LOGGING EXPORTS.
            </p>
          </div>
        </Link>

        <Link href="/dashboard/reports" className="border-[2px] border-[var(--color-iron)] bg-black p-6 hover:bg-[var(--color-alert)] hover:border-[var(--color-alert)] transition-none group cursor-crosshair flex flex-col relative overflow-hidden text-[var(--color-data)] hover:text-black">
          <div className="flex justify-between items-start mb-auto relative z-10 w-full">
            <span className="font-bold border-b border-current pb-1 uppercase tracking-widest">[ INCIDENT_ARCHIVE ]</span>
          </div>
          <div className="relative z-10">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-black uppercase tracking-tighter mb-2">Official<br />Reports</h2>
            <p className="text-xs uppercase font-bold max-w-md opacity-80">
              REVIEW ALERT CLIPS, VLM SUMMARIES, CAMERA METADATA, AND DOWNLOADABLE PDF INCIDENT REPORTS.
            </p>
          </div>
        </Link>
      </div>

      {/* Sidebar Terminal Log */}
      <div className="lg:col-span-4 border-[2px] border-[var(--color-iron)] bg-black flex flex-col relative overflow-hidden p-4 text-[10px] tracking-widest uppercase">
        <div className="border-b-[2px] border-[var(--color-iron)] pb-2 mb-4 font-bold text-[var(--color-silica)] flex justify-between">
          <span>SYS.LOG // {new Date().toISOString().substring(0, 10)}</span>
          <span className="animate-pulse">_</span>
        </div>

        <div className="flex-1 overflow-y-auto relative flex flex-col gap-2 opacity-80 custom-scrollbar pr-2">
          {telemetry.logs.map((log, i) => (
            <div key={i} className={log.includes("[WARN]") || log.includes("ANOMALY") ? "text-[var(--color-alert)]" : "text-[var(--color-data)]"}>
              {log.startsWith("[") ? (
                <>
                  <span className="text-[var(--color-silica)]">{log.substring(0, log.indexOf("]") + 1)}</span>
                  {log.substring(log.indexOf("]") + 1)}
                </>
              ) : log}
            </div>
          ))}
          <div className="sticky bottom-0 w-full h-12 bg-gradient-to-t from-black to-transparent pointer-events-none" />
        </div>
      </div>

    </div>
  );
}
