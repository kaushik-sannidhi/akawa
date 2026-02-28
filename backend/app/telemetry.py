import requests
import threading
import time
from datetime import datetime

FIREBASE_RTDB_BASE = "https://uiuc-24fae-default-rtdb.firebaseio.com/telemetry"

class TelemetryTracker:
    def __init__(self):
        self.pending_frames = {} # dict mapping uid -> frames
        self.pending_anomalies = {} # dict mapping uid -> anomalies
        self.lock = threading.Lock()
        
        # Start background sync thread
        self.running = True
        self.sync_thread = threading.Thread(target=self._sync_loop, daemon=True)
        self.sync_thread.start()
        print("TelemetryTracker initialized to sync with Firebase RTDB")

    def log_frames(self, count, uid="anonymous"):
        with self.lock:
            self.pending_frames[uid] = self.pending_frames.get(uid, 0) + count

    def log_anomaly(self, node_id="NODE_00", uid="anonymous"):
        with self.lock:
            self.pending_anomalies[uid] = self.pending_anomalies.get(uid, 0) + 1
        # Push log immediately
        log_msg = f"[{datetime.now().strftime('%H:%M:%S')}] [WARN] KINETIC ANOMALY CLASSIFIED ON {node_id}"
        self._push_syslog(log_msg, uid)

    def _push_syslog(self, text, uid="anonymous"):
        try:
            # Get current logs to append to it
            res = requests.get(f"{FIREBASE_RTDB_BASE}/{uid}.json")
            data = res.json() or {}
            idx = 0
            if "logs" in data:
                logs = data["logs"]
                if isinstance(logs, dict):
                    idx = len(logs.keys())
                elif isinstance(logs, list):
                    idx = len(logs)
            
            # Keep array size manageable
            requests.patch(f"{FIREBASE_RTDB_BASE}/{uid}/logs/{idx}.json", json=text)
        except Exception as e:
            print(f"Failed to push syslog: {e}")

    def _sync_loop(self):
        while self.running:
            time.sleep(2) # Sync every 2 seconds to avoid spamming RTDB
            
            # Snapshots to safely iterate and process
            frames_to_process = {}
            anomalies_to_process = {}
            
            with self.lock:
                frames_to_process = self.pending_frames.copy()
                anomalies_to_process = self.pending_anomalies.copy()
                self.pending_frames.clear()
                self.pending_anomalies.clear()
                
            # Find all active UIDs this cycle
            active_uids = set(frames_to_process.keys()).union(set(anomalies_to_process.keys()))
            
            for uid in active_uids:
                f_count = frames_to_process.get(uid, 0)
                a_count = anomalies_to_process.get(uid, 0)
                
                if f_count > 0 or a_count > 0:
                    try:
                        # Fetch current totals for THIS user
                        res = requests.get(f"{FIREBASE_RTDB_BASE}/{uid}.json")
                        data = res.json() or {}
                        
                        current_scanned = data.get("scanned", 0)
                        current_anomalies = data.get("anomalies", 0)
                        current_nodes = data.get("activeNodes", 0)
                        
                        new_scanned = current_scanned + f_count
                        new_anomalies = current_anomalies + a_count
                        
                        update_payload = {
                            "scanned": new_scanned,
                            "anomalies": new_anomalies,
                            "activeNodes": current_nodes,
                            "latency": 8
                        }
                        
                        requests.patch(f"{FIREBASE_RTDB_BASE}/{uid}.json", json=update_payload)
                    except Exception as e:
                        print(f"Telemetry sync failed for {uid}: {e}")
                        # Requeue specifically for this user
                        with self.lock:
                            self.pending_frames[uid] = self.pending_frames.get(uid, 0) + f_count
                            self.pending_anomalies[uid] = self.pending_anomalies.get(uid, 0) + a_count

# Global instance
telemetry_service = TelemetryTracker()
