import requests
import threading
import time
from datetime import datetime

FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com/telemetry"

# Firebase Server Values — tells RTDB to atomically increment on the server.
# Usage: PATCH {"scanned": {".sv": {"increment": 5}}}
# This avoids the GET-then-PATCH race condition entirely.
def _increment(n):
    return {".sv": {"increment": n}}


class TelemetryTracker:
    def __init__(self):
        # Pending batches: uid → count / list
        self.pending_frames:    dict = {}   # uid → int
        self.pending_anomalies: dict = {}   # uid → int (total, for backward compat)
        self.pending_by_threat: dict = {}   # uid → {"weapon": int, "fall": int, "violence": int}
        self.latest_nodes:      dict = {}   # uid → int
        self.recent_latencies:  dict = {}   # uid → [ms, ...]
        self.lock = threading.Lock()

        self.running = True
        self.sync_thread = threading.Thread(target=self._sync_loop, daemon=True)
        self.sync_thread.start()
        print("TelemetryTracker initialized — syncing to Firebase RTDB every 2s")

    # ---------------------------------------------------------------- Public API

    def log_frames(self, count: int, uid: str = "anonymous"):
        with self.lock:
            self.pending_frames[uid] = self.pending_frames.get(uid, 0) + count

    def log_anomaly(self, node_id: str = "NODE_00", uid: str = "anonymous",
                    threat_type: str = "unknown"):
        """
        Log a threat detection.

        threat_type should be one of: "weapon", "fall", "violence", "unknown".
        Callers in stream_manager pass stream.latest_threat_type here.
        """
        with self.lock:
            # Total anomaly counter (backward compat)
            self.pending_anomalies[uid] = self.pending_anomalies.get(uid, 0) + 1
            # Per-type breakdown
            if uid not in self.pending_by_threat:
                self.pending_by_threat[uid] = {"weapon": 0, "fall": 0, "violence": 0}
            key = threat_type if threat_type in ("weapon", "fall", "violence") else "weapon"
            self.pending_by_threat[uid][key] += 1

        # Push syslog immediately (outside lock — network call)
        today_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        label = threat_type.upper() if threat_type else "UNKNOWN"
        log_msg = f"[{today_str}] [WARN] {label} DETECTED ON {node_id}"
        self._push_syslog(log_msg, uid)

    def update_nodes(self, count: int, uid: str = "anonymous"):
        with self.lock:
            self.latest_nodes[uid] = count

    def log_latency(self, latency_ms: int, uid: str = "anonymous"):
        with self.lock:
            if uid not in self.recent_latencies:
                self.recent_latencies[uid] = []
            self.recent_latencies[uid].append(latency_ms)

    # ---------------------------------------------------------------- Internal

    def _push_syslog(self, text: str, uid: str = "anonymous"):
        try:
            requests.post(f"{FIREBASE_RTDB_BASE}/{uid}/logs.json",
                          json=text, timeout=4)
        except Exception as e:
            print(f"[Telemetry] Failed to push syslog for {uid}: {e}")

    def _sync_loop(self):
        while self.running:
            time.sleep(2)

            # Snapshot and clear under lock
            with self.lock:
                frames_snap    = self.pending_frames.copy();    self.pending_frames.clear()
                anomaly_snap   = self.pending_anomalies.copy(); self.pending_anomalies.clear()
                threat_snap    = self.pending_by_threat.copy(); self.pending_by_threat.clear()
                nodes_snap     = self.latest_nodes.copy();      self.latest_nodes.clear()
                latency_snap   = self.recent_latencies.copy();  self.recent_latencies.clear()

            active_uids = (set(frames_snap)
                           | set(anomaly_snap)
                           | set(nodes_snap)
                           | set(latency_snap))

            for uid in active_uids:
                f_count   = frames_snap.get(uid, 0)
                a_count   = anomaly_snap.get(uid, 0)
                by_threat = threat_snap.get(uid, {})
                lat_list  = latency_snap.get(uid, [])

                # ── Build the atomic PATCH payload ──────────────────────────
                # Firebase server-side increments remove the GET-then-PATCH
                # race condition entirely. Two concurrent writers both safely
                # add their own delta; neither overwrites the other.
                payload: dict = {}

                if f_count:
                    payload["scanned"] = _increment(f_count)

                if a_count:
                    payload["anomalies"] = _increment(a_count)

                for threat_key, count in by_threat.items():
                    if count:
                        payload[f"anomalies_{threat_key}"] = _increment(count)

                if uid in nodes_snap:
                    # Node count is a SET not an increment — latest value wins
                    payload["activeNodes"] = nodes_snap[uid]

                if lat_list:
                    # Rolling weighted average: blend current batch (weight=1)
                    # with stored average (weight=4) so spikes show but don't
                    # permanently dominate the display value.
                    batch_avg = int(sum(lat_list) / len(lat_list))
                    # We need the current stored value to blend — one GET is
                    # acceptable here since latency is display-only, not a counter.
                    try:
                        res  = requests.get(f"{FIREBASE_RTDB_BASE}/{uid}/latency.json",
                                            timeout=3)
                        stored = res.json() or batch_avg
                        blended = int((stored * 4 + batch_avg) / 5)
                    except Exception:
                        blended = batch_avg
                    payload["latency"] = blended

                if not payload:
                    continue

                try:
                    requests.patch(
                        f"{FIREBASE_RTDB_BASE}/{uid}.json",
                        json=payload,
                        timeout=4,
                    )
                except Exception as e:
                    print(f"[Telemetry] Sync failed for {uid}: {e}")
                    # Re-queue raw counts (not increments) so they survive
                    # the next cycle without double-counting the latency blend.
                    with self.lock:
                        self.pending_frames[uid]    = self.pending_frames.get(uid, 0)    + f_count
                        self.pending_anomalies[uid] = self.pending_anomalies.get(uid, 0) + a_count
                        if by_threat:
                            if uid not in self.pending_by_threat:
                                self.pending_by_threat[uid] = {}
                            for k, v in by_threat.items():
                                self.pending_by_threat[uid][k] = \
                                    self.pending_by_threat[uid].get(k, 0) + v


# Global instance
telemetry_service = TelemetryTracker()