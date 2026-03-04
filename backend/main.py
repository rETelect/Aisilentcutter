# Note: If your editor shows "ModuleNotFoundError", ensure you have selected the 'venv' interpreter.
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
import uvicorn
import shutil
import asyncio
import os
import uuid
from pathlib import Path
from pydantic import BaseModel
from typing import List, Dict, Any
from processor import VideoProcessor
import urllib.parse
from fastapi.staticfiles import StaticFiles
from logger import crash_logger, LOG_FILE
import traceback
app = FastAPI()

# storage for uploaded files
UPLOAD_DIR = Path("uploads")
OUTPUT_DIR = Path("outputs")
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app.mount("/outputs", StaticFiles(directory="outputs"), name="outputs")

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For development convenience
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Track pending chunked uploads: file_id -> {filename, path, chunks_received}
pending_uploads: dict = {}

# Track local file paths for Electron app: file_id -> absolute_path
local_file_paths: dict = {}

# Track active processors for cancellation: file_id -> VideoProcessor
active_processors: dict = {}

# Track extra metadata (like source maps) for projects: file_id -> dict
project_metadata: dict = {}

# active websocket connections
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            await connection.send_json(message)

manager = ConnectionManager()

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Video Jump-Cutter API is running"}

@app.post("/process_local")
async def process_local(request: Request):
    """Register local file path(s) for processing (Electron mode)."""
    body = await request.json()
    # Support both single 'filePath' (legacy) and 'filePaths' (list)
    file_path_str = body.get("filePath")
    file_paths_list = body.get("filePaths")
    
    input_paths = []
    if file_paths_list and isinstance(file_paths_list, list):
        input_paths = [Path(p) for p in file_paths_list]
    elif file_path_str:
        input_paths = [Path(file_path_str)]
    
    if not input_paths:
        return JSONResponse(status_code=400, content={"status": "error", "message": "No filePath provided"})
    
    # Check existence
    for p in input_paths:
        if not p.exists():
             return JSONResponse(status_code=404, content={"status": "error", "message": f"File not found: {p}"})

    file_id = str(uuid.uuid4())
    
    if len(input_paths) == 0:
        return JSONResponse(status_code=400, content={"status": "error", "message": "No valid filePaths provided"})
    
    import ffmpeg
    
    source_map = []
    audio_streams = []
    current_time = 0.0

    async def generate_proxy(cmd: list, display_name: str):
        try:
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            await proc.communicate()
        except Exception as e:
            pass # Proxy failure falls back to original

    for p in input_paths:
        try:
            probe = ffmpeg.probe(str(p))
            dur = float(probe['format']['duration'])
            
            if not audio_streams:
                for s in probe.get('streams', []):
                    if s.get('codec_type') == 'audio':
                        audio_streams.append({
                            "index": s.get('index'),
                            "channels": s.get('channels'),
                            "bit_rate": s.get('bit_rate'),
                            "title": s.get('tags', {}).get('title', f"Track {len(audio_streams)+1}")
                        })
            
            # Check for proxy requirement
            size_bytes = p.stat().st_size
            needs_proxy = size_bytes > 2 * 1024 * 1024 * 1024
            
            # Check resolution
            video_streams = [s for s in probe.get('streams', []) if s.get('codec_type') == 'video']
            if video_streams:
                width = video_streams[0].get('width', 0)
                height = video_streams[0].get('height', 0)
                if width >= 3840 or height >= 2160: # 4K or above
                    needs_proxy = True

            encoded_path = urllib.parse.quote(str(p))
            display_path = f"http://localhost:8000/stream_local?path={encoded_path}"
            
            if needs_proxy:
                proxy_filename = f"proxy_{file_id}_{p.name}.mp4"
                proxy_path = OUTPUT_DIR / proxy_filename
                
                cmd = [
                    "ffmpeg", "-y", "-i", str(p),
                    "-vf", "scale=-2:480",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
                    "-c:a", "aac", "-b:a", "128k",
                    str(proxy_path)
                ]
                asyncio.create_task(generate_proxy(cmd, proxy_filename))
                # Set path directly to the proxy output. It might fail to play immediately if frontend doesn't wait,
                # but it achieves the 'background spawn' goal.
                display_path = f"http://localhost:8000/outputs/{proxy_filename}"
                

            source_map.append({
                "filename": p.name,
                "path": display_path,
                "original_path": str(p),
                "start": current_time,
                "duration": dur,
                "end": current_time + dur
            })
            current_time += dur
        except Exception as e:
            print(f"Error processing {p}: {e}")
            return JSONResponse(status_code=500, content={"status": "error", "message": f"Failed to process {p}: {str(e)}"})
            
    # Store list of paths
    local_file_paths[file_id] = input_paths
    
    # Store metadata
    project_metadata[file_id] = { "sources": source_map, "audio_streams": audio_streams }
    
    filename_res = "Multiple Files" if len(input_paths) > 1 else input_paths[0].name
    return {"file_id": file_id, "filename": filename_res, "status": "ready", "sources": source_map, "audio_streams": audio_streams}

@app.get("/stream_local")
async def stream_local_file(path: str):
    """Serve arbitrary local files to the frontend."""
    p = Path(urllib.parse.unquote(path))
    if not p.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(p)

@app.post("/cancel/{file_id}")
async def cancel_processing(file_id: str):
    """Cancel processing for a specific file."""
    if file_id in active_processors:
        try:
            active_processors[file_id].cancel()
            return {"status": "cancelled", "message": "Cancellation requested"}
        except Exception as e:
            return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})
            
    return JSONResponse(status_code=404, content={"status": "error", "message": "Process not found or already finished"})



# --- Chunked upload endpoints for large files (8GB+) ---

@app.post("/upload/init")
async def upload_init(request: Request):
    """Initialize a chunked upload. Returns a file_id to use for subsequent chunks."""
    body = await request.json()
    filename = body.get("filename", "video.mp4")
    file_size = body.get("fileSize", 0)
    
    file_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"{file_id}_{filename}"
    
    # Create empty file
    file_path.touch()
    
    pending_uploads[file_id] = {
        "filename": filename,
        "path": file_path,
        "file_size": file_size,
        "bytes_received": 0
    }
    
    return {"file_id": file_id, "filename": filename, "status": "initialized"}

@app.post("/upload/chunk/{file_id}")
async def upload_chunk(file_id: str, request: Request):
    """Receive a single chunk and append it to the file."""
    if file_id not in pending_uploads:
        return JSONResponse(status_code=404, content={"error": "Upload not found"})
    
    info = pending_uploads[file_id]
    chunk_data = await request.body()
    
    with open(info["path"], "ab") as f:
        f.write(chunk_data)
    
    info["bytes_received"] += len(chunk_data)
    
    return {"status": "chunk_received", "bytes_received": info["bytes_received"]}

class AnalyzeRequest(BaseModel):
    file_path: str

class AnalyzeProjectRequest(BaseModel):
    file_id: str
    audio_stream_index: int = -1
    settings: Dict[str, Any] = {}

class RenderRequest(BaseModel):
    file_id: str
    segments: List[Dict[str, Any]]
    settings: Dict[str, Any] = {}



@app.post("/analyze_project")
async def analyze_project(request: AnalyzeProjectRequest):
    file_id = request.file_id
    if file_id not in local_file_paths:
        raise HTTPException(status_code=404, detail="Project files not found")
        
    paths = local_file_paths[file_id]
    
    try:
        processor = VideoProcessor(paths, output_dir=OUTPUT_DIR, file_id=file_id, audio_stream_index=request.audio_stream_index)
        
        # Attach settings for VAD and padding if needed
        # We can store them on processor or pass them to process_async
        processor.settings = request.settings
        
        if file_id in project_metadata:
            processor.source_map = project_metadata[file_id].get("sources", [])
        
        active_processors[file_id] = processor
        asyncio.create_task(processor.process_async())
        
        return {"status": "success"}
    except Exception as e:
        crash_logger.error(f"Fatal crash in analyze_project: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail={"error": str(e), "log_path": str(LOG_FILE)})

@app.post("/render")
async def render_video(request: RenderRequest):
    """Render video from manually confirmed segments."""
    file_id = request.file_id
    if file_id not in active_processors:
        raise HTTPException(status_code=404, detail="Project not found or expired")
    
    processor = active_processors[file_id]
    try:
        asyncio.create_task(processor.render_from_segments(request.segments, request.settings))
        return {"status": "success", "message": "Rendering started"}
    except Exception as e:
        crash_logger.error(f"Fatal crash in render_video: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail={"error": str(e), "log_path": str(LOG_FILE)})

# ── Standalone helpers (no live processor required) ─────────────────────────

def _seconds_to_smpte(seconds: float, fps: float) -> str:
    total_frames = int(round(seconds * fps))
    f = total_frames % int(fps)
    s = (total_frames // int(fps)) % 60
    m = (total_frames // int(fps) // 60) % 60
    h = total_frames // int(fps) // 3600
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def _make_edl(file_id: str, segments: List[Dict[str, Any]], fps: float = 30.0) -> str:
    """Generate EDL purely from segment data — no processor object needed."""
    # Try to get the source filename from metadata
    meta = project_metadata.get(file_id, {})
    sources = meta.get("sources", [])
    clip_name = sources[0]["filename"] if sources else f"{file_id}.mp4"

    lines = ["TITLE: JUMP CUTTER PROJECT", "FCM: NON-DROP FRAME\n"]
    timeline_end = 0.0
    kept = [s for s in segments if s.get("type", "keep") == "keep"]
    for i, seg in enumerate(kept):
        start_tc = _seconds_to_smpte(seg["start"], fps)
        end_tc = _seconds_to_smpte(seg["end"], fps)
        dur = seg["end"] - seg["start"]
        rec_start = _seconds_to_smpte(timeline_end, fps)
        rec_end = _seconds_to_smpte(timeline_end + dur, fps)
        lines.append(f"{i+1:03d}  AX       V     C        {start_tc} {end_tc} {rec_start} {rec_end}")
        lines.append(f"* FROM CLIP NAME: {clip_name}\n")
        timeline_end += dur
    return "\n".join(lines)


def _make_fcpxml(file_id: str, segments: List[Dict[str, Any]], fps: float = 30.0) -> str:
    """Generate FCPXML purely from segment data — no processor object needed."""
    meta = project_metadata.get(file_id, {})
    sources = meta.get("sources", [])
    clip_name = sources[0]["filename"] if sources else f"{file_id}.mp4"
    # Try to resolve an absolute path for the asset src
    if sources and "original_path" in sources[0]:
        clip_path = sources[0]["original_path"]
    elif file_id in local_file_paths and local_file_paths[file_id]:
        clip_path = str(local_file_paths[file_id][0])
    else:
        clip_path = ""

    basefps = "30000/1001" if abs(fps - 29.97) < 0.1 else f"{int(fps)}/1"
    if fps == 25.0: basefps = "25/1"
    elif fps == 24.0: basefps = "24/1"
    elif fps == 50.0: basefps = "50/1"
    elif fps == 60.0: basefps = "60/1"

    dur_total = sum((s["end"] - s["start"]) for s in segments if s.get("type", "keep") == "keep")
    kept = [s for s in segments if s.get("type", "keep") == "keep"]

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE fcpxml>',
        '<fcpxml version="1.9">',
        '  <resources>',
        f'    <format id="r1" name="FFVideoFormat1080p{int(fps)}" frameDuration="{basefps}s" width="1920" height="1080"/>',
        f'    <asset id="r2" name="{clip_name}" src="file://{clip_path}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2"/>',
        '  </resources>',
        '  <library>',
        '    <event name="Jump Cutter Event">',
        '      <project name="Jump Cutter Sequence">',
        f'        <sequence format="r1" duration="{dur_total}s" tcStart="0s" tcFormat="NDF">',
        '          <spine>',
    ]
    for seg in kept:
        dur = seg["end"] - seg["start"]
        start = seg["start"]
        lines.append(f'            <asset-clip name="{clip_name}" ref="r2" duration="{dur}s" start="{start}s" format="r1"/>')
    lines += [
        '          </spine>',
        '        </sequence>',
        '      </project>',
        '    </event>',
        '  </library>',
        '</fcpxml>',
    ]
    return "\n".join(lines)


@app.post("/export_edl")
async def export_edl_endpoint(request: RenderRequest):
    """Generate and stream an EDL file. Works even when the processor is no longer active."""
    from fastapi.responses import PlainTextResponse
    edl_str = _make_edl(request.file_id, request.segments)
    return PlainTextResponse(
        edl_str,
        headers={"Content-Disposition": f'attachment; filename="project_{request.file_id}.edl"'}
    )


@app.post("/export_fcpxml")
async def export_fcpxml_endpoint(request: RenderRequest):
    """Generate and stream an FCPXML file. Works even when the processor is no longer active."""
    from fastapi.responses import Response
    xml_str = _make_fcpxml(request.file_id, request.segments)
    return Response(
        content=xml_str,
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="project_{request.file_id}.fcpxml"'}
    )


@app.get("/download/{filename}")
async def download_file(filename: str):
    """Force download of a finished video rather than streaming it."""
    from fastapi.responses import FileResponse
    import os
    file_path = os.path.join(OUTPUT_DIR, filename)
    if not os.path.exists(file_path):
        return JSONResponse(status_code=404, content={"error": "File not found"})
        
    return FileResponse(
        path=file_path,
        filename=filename,
        media_type="video/mp4",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@app.post("/extract_chapters")
async def extract_chapters_endpoint(request: RenderRequest):
    """Extract AI chapters. Requires an active processor (Whisper + spaCy)."""
    file_id = request.file_id
    if file_id not in active_processors:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "message": "Chapter extraction requires an active processing session. Please re-run analysis first."}
        )
    processor = active_processors[file_id]
    try:
        # Whisper transcription on CPU can take many minutes for long videos.
        # Wait up to 10 minutes before giving up.
        chapters = await asyncio.wait_for(
            processor.extract_chapters_async(window_size=60.0),
            timeout=600
        )
        return {"status": "success", "chapters": chapters}
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={"status": "error", "message": "Chapter extraction timed out (>10 min). Try a shorter video or use a GPU."}
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": f"Chapter extraction failed: {e}"}
        )


@app.get("/project/{file_id}")
async def get_project_status(file_id: str):
    """Get current project status and data."""
    if file_id not in active_processors:
        raise HTTPException(status_code=404, detail="Project not found")
    
    proc = active_processors[file_id]
    # We might need to store segments in processor to retrieve them here
    # Currently they are returned by process_async but not stored in a public attribute?
    # We should update processor.py to store self.segments
    return {
        "file_id": file_id,
        "status": "active", # Simplified
        "file_path": str(proc.file_path),
        "segments": proc.segments,
        "sources": proc.source_map
    }

@app.get("/project/{file_id}/waveform")
async def get_project_waveform(file_id: str):
    """Get waveform peak data for visualization."""
    if file_id not in active_processors:
        raise HTTPException(status_code=404, detail="Project not found")
        
    proc = active_processors[file_id]
    data = proc.get_waveform_data()
    return {"waveform": data}

@app.get("/stream/{file_id}")
async def stream_video(file_id: str):
    """Stream the video file for preview."""
    if file_id not in active_processors:
        raise HTTPException(status_code=404, detail="Project not found")
    
    proc = active_processors[file_id]
    if not proc.file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
        
    return FileResponse(proc.file_path)

@app.post("/upload/complete/{file_id}")
async def upload_complete(file_id: str):
    """Finalize a chunked upload."""
    if file_id not in pending_uploads:
        return JSONResponse(status_code=404, content={"error": "Upload not found"})
    
    info = pending_uploads.pop(file_id)
    
    return {
        "file_id": file_id,
        "filename": info["filename"],
        "status": "uploaded",
        "total_bytes": info["bytes_received"]
    }

@app.get("/status/{file_id}")
async def get_processor_status(file_id: str):
    """Fallback HTTP endpoint for polling progress."""
    if file_id not in active_processors:
        # Check if project exists on disk first before error
        if (OUTPUT_DIR / f"{file_id}_vad.json").exists():
            return {
                 "status": "success",
                 "step": "analysis_complete",
                 "progress": 100,
                 "eta_display": ""
            }
        return JSONResponse(status_code=404, content={"status": "error", "message": "Process not found or already finished"})
    
    proc = active_processors[file_id]
    
    # If render completes or aborts
    if proc.completion_event.is_set():
        current_step = getattr(proc, 'current_step', '')
        if current_step == 'error':
            return {
                "status": "error",
                "step": "error",
                "message": getattr(proc, 'eta_display', "Unknown rendering error"),
                "log_path": str(LOG_FILE)
            }
            
        return {
            "status": "success",
            "step": "complete",
            "progress": 100,
            "output_file": os.path.basename(proc.final_output) if proc.final_output else ""
        }
        
    return {
         "status": "success",
         # Simulate progress callback using processor properties if available
         "step": getattr(proc, 'current_step', "processing"), 
         "progress": getattr(proc, 'progress', 0), # Fallback if added
         "eta_display": getattr(proc, 'eta_display', "")
    }

@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup active processors on shutdown."""
    for file_id, processor in list(active_processors.items()):
        try:
            processor.cancel()
        except Exception:
            pass

if __name__ == "__main__":
    import uvicorn
    # Use 0.0.0.0 to allow external access if needed, but localhost is safer for desktop app
    uvicorn.run(app, host="0.0.0.0", port=8000)
