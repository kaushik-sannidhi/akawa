"""
WebSocket server for live video streaming.

Handles two endpoint types:
  /ws/stream_in/{stream_id}  — publisher (browser camera sends JPEG frames)
  /ws/viewer/{stream_id}     — viewer (receives JPEG frames + detection JSON)

Uses the `websockets` library for high-performance async WebSocket handling.
Runs on a dedicated port (default 9001) alongside the main FastAPI server.
"""

import asyncio
import logging

import cv2
import numpy as np
import websockets

logger = logging.getLogger(__name__)


async def _handle_publisher(websocket, stream_id: str):
    """
    Publisher connection: receives binary JPEG frames from a browser camera,
    stores them for AI processing, and relays them to all viewers.
    """
    from app.stream_manager import stream_manager

    stream = stream_manager.get_stream(stream_id)
    if not stream:
        await websocket.close(1008, "Stream not found")
        return

    stream.picows_publishers.add(websocket)
    await stream_manager.activate_stream(stream)
    logger.info(f"[WS] Publisher connected for stream {stream_id}")

    try:
        async for message in websocket:
            if isinstance(message, bytes):
                # Decode JPEG for AI processing
                nparr = np.frombuffer(message, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if frame is not None:
                    stream.latest_frame_cv2 = frame
                    stream.push_frame(frame, message)

                # Relay binary frame to all viewers
                viewers = list(stream.picows_viewers)
                if viewers:
                    bad = set()
                    for v in viewers:
                        try:
                            await v.send(message)
                        except Exception:
                            bad.add(v)
                    for v in bad:
                        stream.picows_viewers.discard(v)

            elif isinstance(message, str):
                if message == "ping":
                    try:
                        await websocket.send("pong")
                    except Exception:
                        pass
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as exc:
        logger.error(f"[WS] Publisher error for stream {stream_id}: {exc}")
    finally:
        stream.picows_publishers.discard(websocket)
        await stream_manager.deactivate_stream(stream)
        logger.info(f"[WS] Publisher disconnected for stream {stream_id}")


async def _handle_viewer(websocket, stream_id: str):
    """
    Viewer connection: receives relayed JPEG frames and detection JSON
    pushed by the stream manager's broadcast helpers.
    """
    from app.stream_manager import stream_manager

    stream = stream_manager.get_stream(stream_id)
    if not stream:
        await websocket.close(1008, "Stream not found")
        return

    stream.picows_viewers.add(websocket)
    await stream_manager.activate_stream(stream)
    logger.info(f"[WS] Viewer connected for stream {stream_id}")

    try:
        async for message in websocket:
            # Viewers mainly listen; handle keep-alive pings
            if isinstance(message, str):
                if message == "ping":
                    try:
                        await websocket.send("pong")
                    except Exception:
                        pass
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as exc:
        logger.error(f"[WS] Viewer error for stream {stream_id}: {exc}")
    finally:
        stream.picows_viewers.discard(websocket)
        await stream_manager.deactivate_stream(stream)
        logger.info(f"[WS] Viewer disconnected for stream {stream_id}")


async def _handler(websocket):
    """Route incoming WebSocket connections based on URL path."""
    path = websocket.request.path

    if path.startswith("/ws/stream_in/"):
        stream_id = path[len("/ws/stream_in/"):]
        await _handle_publisher(websocket, stream_id)
    elif path.startswith("/ws/viewer/"):
        stream_id = path[len("/ws/viewer/"):]
        await _handle_viewer(websocket, stream_id)
    else:
        await websocket.close(1008, "Invalid path")


async def start_picows_server(host: str = "0.0.0.0", port: int = 9001):
    """Start the WebSocket streaming server."""
    logger.info(f"[WS] Starting WebSocket server on ws://{host}:{port}")
    async with websockets.serve(
        _handler,
        host,
        port,
        max_size=2 ** 22,           # 4 MB max message (JPEG frames)
        ping_interval=30,
        ping_timeout=10,
        compression=None,           # No compression for binary frames (JPEG already compressed)
    ):
        await asyncio.Future()      # Run forever
